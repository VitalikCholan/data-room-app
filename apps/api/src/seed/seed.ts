import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { NestFactory } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import * as argon2 from 'argon2'
import { AppModule } from '../app.module'
import { AppEnv } from '../config/env'
import { PrismaService } from '../prisma/prisma.service'
import {
  ALLOWED_MIME,
  blobKeyFor,
  StorageService,
} from '../storage/storage.service'
import { generateShareToken } from '../access/share-token'
import { childPath, ROOT_PATH } from '../nodes/node-path'
import { makePdf } from './make-pdf'

const OWNER_EMAIL = 'demo@dataroom.app'
const GUEST_EMAIL = 'counsel@example.com'
const PASSWORD = 'demo1234'
const ROOM_NAME = 'Project Titan — Acme Acquisition'

/** Top-level folders of the room, each with the files that live directly inside. */
const TREE: Record<string, string[]> = {
  '01 Corporate': [
    'Certificate of Incorporation.pdf',
    'Bylaws.pdf',
    'Cap Table.pdf',
    'Board Consents 2025.pdf',
  ],
  '02 Financials': [
    'FY23 Audited Statements.pdf',
    'FY24 Audited Statements.pdf',
    'Management Accounts Q1.pdf',
    'Working Capital Model.pdf',
  ],
  '03 Legal': ['Master Services Agreement.pdf', 'Litigation Summary.pdf'],
  '04 IP': [
    'Patent Portfolio.pdf',
    'Trademark Register.pdf',
    'Open Source Inventory.pdf',
  ],
  '05 Commercial': [
    'Top 20 Customers.pdf',
    'Churn Analysis.pdf',
    'Pricing Policy.pdf',
  ],
  '06 People': [
    'Org Chart.pdf',
    'Employment Agreements Summary.pdf',
    'Option Grants.pdf',
  ],
}

/** A second level, so the breadcrumb and the subtree rollups have something to do. */
const NESTED: { parent: string; name: string; files: string[] }[] = [
  {
    parent: '02 Financials',
    name: 'FY23',
    files: ['FY23 Trial Balance.pdf', 'FY23 Revenue by Segment.pdf'],
  },
  {
    parent: '03 Legal',
    name: 'Contracts',
    files: [
      'Reseller Agreement — EMEA.pdf',
      'NDA — Acquirer.pdf',
      'Supplier Framework.pdf',
    ],
  },
]

type Parent = { id: string; path: string }

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  })
  const prisma = app.get(PrismaService)
  const storage = app.get(StorageService)
  const config = app.get<ConfigService<AppEnv, true>>(ConfigService)

  // Re-runnable by construction: the demo accounts are dropped and rebuilt, and
  // DataRoom -> Node -> FileVersion/Share all cascade from the owner row. The blobs
  // do not cascade, so they are removed first — otherwise every re-seed would leave
  // another 24 orphaned objects in the bucket, since new nodes get new uuids and
  // therefore new keys.
  const stale = await prisma.fileVersion.findMany({
    where: {
      node: { room: { owner: { email: { in: [OWNER_EMAIL, GUEST_EMAIL] } } } },
    },
    select: { blobKey: true },
  })
  for (const version of stale) await storage.remove(version.blobKey)
  await prisma.user.deleteMany({
    where: { email: { in: [OWNER_EMAIL, GUEST_EMAIL] } },
  })

  const passwordHash = await argon2.hash(PASSWORD)
  const owner = await prisma.user.create({
    data: { email: OWNER_EMAIL, name: 'Dana Owner', passwordHash },
  })
  const guest = await prisma.user.create({
    data: { email: GUEST_EMAIL, name: 'Sam Counsel', passwordHash },
  })

  const roomId = randomUUID()
  const rootId = randomUUID()
  await prisma.dataRoom.create({
    data: {
      id: roomId,
      ownerId: owner.id,
      name: ROOM_NAME,
      rootNodeId: rootId,
    },
  })
  await prisma.node.create({
    data: {
      id: rootId,
      roomId,
      parentId: null,
      type: 'FOLDER',
      name: ROOM_NAME,
      path: ROOT_PATH,
      status: 'ACTIVE',
      createdById: owner.id,
    },
  })
  const root: Parent = { id: rootId, path: ROOT_PATH }

  const addFolder = async (parent: Parent, name: string): Promise<Parent> => {
    const folder = await prisma.node.create({
      data: {
        roomId,
        parentId: parent.id,
        type: 'FOLDER',
        name,
        path: childPath(parent),
        status: 'ACTIVE',
        createdById: owner.id,
      },
    })
    return { id: folder.id, path: folder.path }
  }

  /**
   * The same sequence UploadsService.presign/confirm performs, minus the HTTP hops:
   * write the bytes through a presigned PUT, then HEAD the object and store the size
   * and the ETag it reports. The ETag matters — FilesService compares the stored
   * checksum against a live HEAD and answers 410 on any mismatch, so a seeded file
   * with a made-up (or absent) checksum would be unopenable in the viewer.
   */
  const addFile = async (parent: Parent, name: string) => {
    const nodeId = randomUUID()
    const versionNo = 1
    const pdf = await makePdf(name.replace(/\.pdf$/i, ''), [
      'Generated seed data for the Data Room demo.',
      `File: ${name}`,
      'Prepared for evaluation purposes only.',
    ])

    const blobKey = blobKeyFor(roomId, nodeId, versionNo)
    const { url } = await storage.presignPut(blobKey, ALLOWED_MIME)
    const put = await fetch(url, {
      method: 'PUT',
      body: pdf,
      headers: { 'Content-Type': ALLOWED_MIME },
    })
    if (!put.ok)
      throw new Error(`Seed upload failed for ${name}: HTTP ${put.status}`)

    const head = await storage.head(blobKey)
    if (!head) throw new Error(`Seed object missing after PUT: ${blobKey}`)
    const sizeBytes = BigInt(head.contentLength)

    await prisma.node.create({
      data: {
        id: nodeId,
        roomId,
        parentId: parent.id,
        type: 'FILE',
        name,
        path: childPath(parent),
        status: 'ACTIVE',
        sizeBytes,
        createdById: owner.id,
      },
    })
    const version = await prisma.fileVersion.create({
      data: {
        nodeId,
        versionNo,
        blobKey,
        sizeBytes,
        mimeType: ALLOWED_MIME,
        checksum: head.etag,
        createdById: owner.id,
      },
    })
    await prisma.node.update({
      where: { id: nodeId },
      data: { currentVersionId: version.id },
    })
    return sizeBytes
  }

  const folders: Record<string, Parent> = {}
  let files = 0
  let bytes = 0n

  for (const [folderName, names] of Object.entries(TREE)) {
    folders[folderName] = await addFolder(root, folderName)
    for (const name of names) {
      bytes += await addFile(folders[folderName], name)
      files += 1
    }
  }

  for (const { parent, name, files: names } of NESTED) {
    const folder = await addFolder(folders[parent], name)
    folders[`${parent}/${name}`] = folder
    for (const fileName of names) {
      bytes += await addFile(folder, fileName)
      files += 1
    }
  }

  // A named grant, so signing in as the guest shows a tree that starts at 03 Legal
  // and offers no way up. granteeId is filled in because the account exists; an
  // invite to an unregistered address would carry the email alone.
  const legal = folders['03 Legal']
  await prisma.share.create({
    data: {
      nodeId: legal.id,
      mode: 'USER',
      role: 'VIEWER',
      granteeEmail: GUEST_EMAIL,
      granteeId: guest.id,
      createdById: owner.id,
    },
  })

  // A public link on a deeper folder, so the scoping is visible without an account.
  const fy23 = folders['02 Financials/FY23']
  const { token, tokenHash } = generateShareToken()
  await prisma.share.create({
    data: {
      nodeId: fy23.id,
      mode: 'PUBLIC_LINK',
      role: 'VIEWER',
      tokenHash,
      createdById: owner.id,
    },
  })

  const appUrl = config.get('PUBLIC_APP_URL', { infer: true })
  process.stdout.write(
    [
      '',
      `Seed complete — ${ROOM_NAME}`,
      `  ${Object.keys(folders).length} folders, ${files} files, ${bytes} bytes of real PDF in the bucket`,
      '',
      `  Owner:  ${OWNER_EMAIL} / ${PASSWORD}`,
      `  Guest:  ${GUEST_EMAIL} / ${PASSWORD}   (granted "03 Legal" only)`,
      `  Public link: ${appUrl}/s/${token}   (scoped to "02 Financials/FY23")`,
      '',
    ].join('\n'),
  )

  await app.close()
}

main().catch((error: unknown) => {
  console.error(error)
  // exit rather than rethrow: the Nest context still holds an open pg pool, so a
  // failed seed would otherwise hang instead of reporting.
  process.exit(1)
})
