import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { randomUUID } from 'node:crypto'
import { AppModule } from '../src/app.module'
import { PendingSweepService } from '../src/uploads/pending-sweep.service'
import { blobKeyFor, StorageService } from '../src/storage/storage.service'
import { createFile, createRoom, createUser, prisma } from './factories'
import { truncateDb } from './support/truncate-db'

describe('PendingSweepService', () => {
  let app: INestApplication
  let sweep: PendingSweepService
  let storage: StorageService

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = mod.createNestApplication()
    await app.init()
    sweep = mod.get(PendingSweepService)
    storage = mod.get(StorageService)
  })
  afterAll(async () => {
    await truncateDb(prisma)
    await app.close()
    await prisma.$disconnect()
  })

  it('removes a stale PENDING node, its version rows and its blob', async () => {
    const owner = await createUser()
    const { roomId, rootId } = await createRoom(owner.id)
    const nodeId = randomUUID()
    const blobKey = blobKeyFor(roomId, nodeId, 1)

    const { url } = await storage.presignPut(blobKey, 'application/pdf')
    const put = await fetch(url, {
      method: 'PUT',
      body: Buffer.from('%PDF-1.7\n'),
      headers: { 'Content-Type': 'application/pdf' },
    })
    expect(put.ok).toBe(true)

    const old = new Date(Date.now() - 48 * 3600 * 1000)
    await prisma.node.create({
      data: {
        id: nodeId,
        roomId,
        parentId: rootId,
        type: 'FILE',
        name: 'abandoned.pdf',
        path: `/${rootId}/`,
        status: 'PENDING',
        createdById: owner.id,
        createdAt: old,
      },
    })
    await prisma.fileVersion.create({
      data: {
        nodeId,
        versionNo: 1,
        blobKey,
        sizeBytes: BigInt(0),
        mimeType: 'application/pdf',
        createdById: owner.id,
        createdAt: old,
      },
    })

    const result = await sweep.sweep(new Date(Date.now() - 24 * 3600 * 1000))
    expect(result.nodes).toBeGreaterThanOrEqual(1)
    await expect(
      prisma.node.findUnique({ where: { id: nodeId } }),
    ).resolves.toBeNull()
    await expect(
      prisma.fileVersion.findFirst({ where: { nodeId } }),
    ).resolves.toBeNull()
    await expect(storage.head(blobKey)).resolves.toBeNull()
  })

  it('removes an abandoned new-version upload without touching live history', async () => {
    const owner = await createUser()
    const { roomId, root } = await createRoom(owner.id)
    const file = await createFile({ ...root, roomId }, 'live.pdf', owner.id)
    const currentNo = 1
    const abandonedKey = blobKeyFor(roomId, file.id, currentNo + 1)

    const old = new Date(Date.now() - 48 * 3600 * 1000)
    const abandoned = await prisma.fileVersion.create({
      data: {
        nodeId: file.id,
        versionNo: currentNo + 1,
        blobKey: abandonedKey,
        sizeBytes: BigInt(0),
        mimeType: 'application/pdf',
        createdById: owner.id,
        createdAt: old,
      },
    })

    const result = await sweep.sweep(new Date(Date.now() - 24 * 3600 * 1000))
    expect(result.versions).toBeGreaterThanOrEqual(1)
    await expect(
      prisma.fileVersion.findUnique({ where: { id: abandoned.id } }),
    ).resolves.toBeNull()
    // v1 is still current and still present.
    await expect(
      prisma.fileVersion.findFirst({
        where: { nodeId: file.id, versionNo: 1 },
      }),
    ).resolves.not.toBeNull()
    await expect(
      prisma.node.findUniqueOrThrow({ where: { id: file.id } }),
    ).resolves.toMatchObject({
      status: 'ACTIVE',
      currentVersionId: file.currentVersionId,
    })
  })

  it('leaves a fresh reservation above the current version alone', async () => {
    const owner = await createUser()
    const { roomId, root } = await createRoom(owner.id)
    const file = await createFile(
      { ...root, roomId },
      'uploading.pdf',
      owner.id,
    )
    const fresh = await prisma.fileVersion.create({
      data: {
        nodeId: file.id,
        versionNo: 2,
        blobKey: blobKeyFor(roomId, file.id, 2),
        sizeBytes: BigInt(0),
        mimeType: 'application/pdf',
        createdById: owner.id,
      },
    })
    await sweep.sweep(new Date(Date.now() - 24 * 3600 * 1000))
    await expect(
      prisma.fileVersion.findUnique({ where: { id: fresh.id } }),
    ).resolves.not.toBeNull()
  })

  it('leaves a confirmed version below the current one alone — restore appends, never rewinds', async () => {
    const owner = await createUser()
    const { roomId, root } = await createRoom(owner.id)
    const file = await createFile({ ...root, roomId }, 'restored.pdf', owner.id)
    const old = new Date(Date.now() - 48 * 3600 * 1000)
    const v1 = await prisma.fileVersion.findFirstOrThrow({
      where: { nodeId: file.id, versionNo: 1 },
    })
    // What a restore leaves behind: v2 is current, v1 is old history with real bytes.
    const v2 = await prisma.fileVersion.create({
      data: {
        nodeId: file.id,
        versionNo: 2,
        blobKey: v1.blobKey,
        sizeBytes: v1.sizeBytes,
        mimeType: 'application/pdf',
        createdById: owner.id,
        createdAt: old,
      },
    })
    await prisma.node.update({
      where: { id: file.id },
      data: { currentVersionId: v2.id },
    })

    await sweep.sweep(new Date(Date.now() - 24 * 3600 * 1000))
    expect(await prisma.fileVersion.count({ where: { nodeId: file.id } })).toBe(
      2,
    )
  })

  it('leaves a fresh PENDING node alone — the user may still be uploading', async () => {
    const owner = await createUser()
    const { roomId, rootId } = await createRoom(owner.id)
    const node = await prisma.node.create({
      data: {
        roomId,
        parentId: rootId,
        type: 'FILE',
        name: 'in-flight.pdf',
        path: `/${rootId}/`,
        status: 'PENDING',
        createdById: owner.id,
      },
    })
    await sweep.sweep(new Date(Date.now() - 24 * 3600 * 1000))
    await expect(
      prisma.node.findUnique({ where: { id: node.id } }),
    ).resolves.not.toBeNull()
  })
})
