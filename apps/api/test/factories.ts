import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client'
import { NodeType } from '../src/generated/prisma/enums'
import { randomUUID } from 'node:crypto'
import * as argon2 from 'argon2'
import { childPath, ROOT_PATH } from '../src/nodes/node-path'

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

export async function createUser(password = 'password123') {
  const email = `u-${randomUUID()}@test.io`
  const user = await prisma.user.create({
    data: {
      email,
      name: 'Test User',
      passwordHash: await argon2.hash(password),
    },
  })
  return { ...user, password }
}

export async function createRoom(ownerId: string, name = 'Project Titan') {
  const roomId = randomUUID()
  const rootId = randomUUID()
  // DataRoom first: Node.roomId is a foreign key to it. rootNodeId is only unique,
  // not a foreign key, so it can name a row that does not exist yet.
  await prisma.dataRoom.create({
    data: { id: roomId, ownerId, name, rootNodeId: rootId },
  })
  const root = await prisma.node.create({
    data: {
      id: rootId,
      roomId,
      parentId: null,
      type: 'FOLDER',
      name,
      path: ROOT_PATH,
      status: 'ACTIVE',
      createdById: ownerId,
    },
  })
  return { roomId, rootId, root }
}

export async function createFolder(
  parent: { id: string; path: string; roomId: string },
  name: string,
  createdById: string,
) {
  return prisma.node.create({
    data: {
      roomId: parent.roomId,
      parentId: parent.id,
      type: 'FOLDER',
      name,
      path: childPath(parent),
      status: 'ACTIVE',
      createdById,
    },
  })
}

export async function createFile(
  parent: { id: string; path: string; roomId: string },
  name: string,
  createdById: string,
  sizeBytes = 1024,
) {
  const node = await prisma.node.create({
    data: {
      roomId: parent.roomId,
      parentId: parent.id,
      type: NodeType.FILE,
      name,
      path: childPath(parent),
      status: 'ACTIVE',
      sizeBytes: BigInt(sizeBytes),
      createdById,
    },
  })
  const version = await prisma.fileVersion.create({
    data: {
      nodeId: node.id,
      versionNo: 1,
      blobKey: `rooms/${parent.roomId}/nodes/${node.id}/v1`,
      sizeBytes: BigInt(sizeBytes),
      mimeType: 'application/pdf',
      createdById,
    },
  })
  return prisma.node.update({
    where: { id: node.id },
    data: { currentVersionId: version.id },
  })
}

export async function createShare(input: {
  nodeId: string
  mode: 'PUBLIC_LINK' | 'USER'
  createdById: string
  tokenHash?: string
  granteeEmail?: string
}) {
  // Lowercased on write, matching RoomsService.listSharedWithMe (and Task 9's
  // AccessResolver), both of which match on `email.toLowerCase()` — a mixed-case
  // grantee address here would silently never match either lookup.
  return prisma.share.create({
    data: {
      ...input,
      granteeEmail: input.granteeEmail?.toLowerCase(),
      role: 'VIEWER',
    },
  })
}
