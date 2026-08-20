import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { randomUUID } from 'node:crypto'
import { AppModule } from '../src/app.module'
import { PendingSweepService } from '../src/uploads/pending-sweep.service'
import { blobKeyFor, StorageService } from '../src/storage/storage.service'
import { createRoom, createUser, prisma } from './factories'
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
