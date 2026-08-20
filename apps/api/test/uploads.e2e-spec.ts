import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { configureApp } from '../src/bootstrap'
import { StorageService } from '../src/storage/storage.service'
import { createFolder, createRoom, createUser, prisma } from './factories'
import { truncateDb } from './support/truncate-db'

const PDF = Buffer.from('%PDF-1.7\n% e2e fixture\n')

// supertest types `Response.body` as `any`; these give the shapes this suite actually
// reads back so lint's typed rules can verify property access — same pattern as
// nodes-list.e2e-spec.ts.
type LoginBody = { accessToken: string }
type PresignBody = {
  nodeId: string
  versionId: string
  versionNo: number
  blobKey: string
  uploadUrl: string
  expiresAt: string
  name: string
}
type ErrorBody = { code: string; details?: Record<string, unknown> }
type NodeBody = { id: string; status: string; sizeBytes: number }
type ListBody = { items: unknown[] }

describe('uploads', () => {
  let app: INestApplication
  let storage: StorageService

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = mod.createNestApplication()
    configureApp(app)
    await app.init()
    storage = mod.get(StorageService)
  })
  afterAll(async () => {
    await truncateDb(prisma)
    await app.close()
    await prisma.$disconnect()
  })

  async function authFor(user: { email: string; password: string }) {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
    const { accessToken } = loginRes.body as LoginBody
    return { Authorization: `Bearer ${accessToken}` }
  }

  async function fixture() {
    const owner = await createUser()
    const { roomId, rootId } = await createRoom(owner.id)
    return { owner, roomId, rootId, auth: await authFor(owner) }
  }

  async function upload(
    f: Awaited<ReturnType<typeof fixture>>,
    name: string,
    body = PDF,
    onConflict?: string,
  ) {
    const presign = await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/uploads/presign`)
      .set(f.auth)
      .send({
        parentId: f.rootId,
        name,
        sizeBytes: body.byteLength,
        mimeType: 'application/pdf',
        ...(onConflict ? { onConflict } : {}),
      })
    return { presign, presignBody: presign.body as PresignBody, body }
  }

  async function put(url: string, body: Buffer) {
    const res = await fetch(url, {
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/pdf' },
    })
    expect(res.ok).toBe(true)
  }

  it('creates a PENDING node at presign that no listing shows', async () => {
    const f = await fixture()
    const { presign, presignBody } = await upload(f, 'quarterly.pdf')
    expect(presign.status).toBe(201)
    expect(presign.body).toMatchObject({ versionNo: 1, name: 'quarterly.pdf' })

    const node = await prisma.node.findUniqueOrThrow({
      where: { id: presignBody.nodeId },
    })
    expect(node.status).toBe('PENDING')

    const list = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes`)
      .set(f.auth)
      .expect(200)
    expect((list.body as ListBody).items).toEqual([])
  })

  it('activates the node on confirm and takes size and type from the bucket, not the client', async () => {
    const f = await fixture()
    const { presignBody } = await upload(f, 'real.pdf')
    await put(presignBody.uploadUrl, PDF)

    const confirmed = await request(app.getHttpServer())
      .post(`/uploads/${presignBody.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presignBody.versionId })
      .expect(201)

    expect(confirmed.body).toMatchObject({
      status: 'ACTIVE',
      sizeBytes: PDF.byteLength,
    })
    const version = await prisma.fileVersion.findUniqueOrThrow({
      where: { id: presignBody.versionId },
    })
    expect(Number(version.sizeBytes)).toBe(PDF.byteLength)
    // The ETag observed at confirm time is pinned as the version checksum.
    expect(version.checksum).toEqual(expect.any(String))
    expect(version.checksum).not.toContain('"')
  })

  it('lies about its size in vain — confirm overwrites the claim', async () => {
    const f = await fixture()
    const presign = await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/uploads/presign`)
      .set(f.auth)
      .send({
        parentId: f.rootId,
        name: 'liar.pdf',
        sizeBytes: 999_999,
        mimeType: 'application/pdf',
      })
      .expect(201)
    const presignBody = presign.body as PresignBody
    await put(presignBody.uploadUrl, PDF)

    const confirmed = await request(app.getHttpServer())
      .post(`/uploads/${presignBody.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presignBody.versionId })
      .expect(201)
    expect((confirmed.body as NodeBody).sizeBytes).toBe(PDF.byteLength)
  })

  it('returns 409 UPLOAD_NOT_FOUND when confirm runs before the PUT', async () => {
    const f = await fixture()
    const { presignBody } = await upload(f, 'never-uploaded.pdf')
    const res = await request(app.getHttpServer())
      .post(`/uploads/${presignBody.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presignBody.versionId })
      .expect(409)
    expect((res.body as ErrorBody).code).toBe('UPLOAD_NOT_FOUND')

    const node = await prisma.node.findUniqueOrThrow({
      where: { id: presignBody.nodeId },
    })
    expect(node.status).toBe('PENDING')
  })

  it('rejects an object over the cap with 413 and deletes it', async () => {
    const f = await fixture()
    const { presignBody } = await upload(f, 'huge.pdf')
    const oversized = Buffer.alloc(50 * 1024 * 1024 + 1, 0x20)
    await put(presignBody.uploadUrl, oversized)

    await request(app.getHttpServer())
      .post(`/uploads/${presignBody.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presignBody.versionId })
      .expect(413)

    await expect(storage.head(presignBody.blobKey)).resolves.toBeNull()
    expect(
      await prisma.fileVersion.count({
        where: { id: presignBody.versionId },
      }),
    ).toBe(0)
    const node = await prisma.node.findUniqueOrThrow({
      where: { id: presignBody.nodeId },
    })
    expect(node.deletedAt).not.toBeNull()
  })

  it('rejects a non-PDF object with 415 and deletes it', async () => {
    const f = await fixture()
    const { presignBody } = await upload(f, 'sneaky.pdf')
    const res = await fetch(presignBody.uploadUrl, {
      method: 'PUT',
      body: Buffer.from('<html>not a pdf</html>'),
      headers: { 'Content-Type': 'text/html' },
    })
    expect(res.ok).toBe(true)

    await request(app.getHttpServer())
      .post(`/uploads/${presignBody.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presignBody.versionId })
      .expect(415)

    await expect(storage.head(presignBody.blobKey)).resolves.toBeNull()
    expect(
      await prisma.fileVersion.count({
        where: { id: presignBody.versionId },
      }),
    ).toBe(0)
    const node = await prisma.node.findUniqueOrThrow({
      where: { id: presignBody.nodeId },
    })
    expect(node.deletedAt).not.toBeNull()
  })

  it('is idempotent: a second confirm returns the same node without a new version', async () => {
    const f = await fixture()
    const { presignBody } = await upload(f, 'twice.pdf')
    await put(presignBody.uploadUrl, PDF)
    const first = await request(app.getHttpServer())
      .post(`/uploads/${presignBody.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presignBody.versionId })
      .expect(201)
    const second = await request(app.getHttpServer())
      .post(`/uploads/${presignBody.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presignBody.versionId })
      .expect(201)

    expect((second.body as NodeBody).id).toBe((first.body as NodeBody).id)
    expect(
      await prisma.fileVersion.count({
        where: { nodeId: presignBody.nodeId },
      }),
    ).toBe(1)
  })

  it('returns 409 NAME_CONFLICT with the existing version when no strategy is given', async () => {
    const f = await fixture()
    const first = await upload(f, 'invoice.pdf')
    await put(first.presignBody.uploadUrl, PDF)
    await request(app.getHttpServer())
      .post(`/uploads/${first.presignBody.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: first.presignBody.versionId })
      .expect(201)

    const clash = await upload(f, 'INVOICE.pdf')
    expect(clash.presign.status).toBe(409)
    expect(clash.presign.body).toMatchObject({
      code: 'NAME_CONFLICT',
      details: {
        existingNodeId: first.presignBody.nodeId,
        currentVersionNo: 1,
      },
    })
  })

  it('KEEP_BOTH creates a separate node with a (2) suffix', async () => {
    const f = await fixture()
    const first = await upload(f, 'deck.pdf')
    await put(first.presignBody.uploadUrl, PDF)
    await request(app.getHttpServer())
      .post(`/uploads/${first.presignBody.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: first.presignBody.versionId })
      .expect(201)

    const second = await upload(f, 'deck.pdf', PDF, 'KEEP_BOTH')
    expect(second.presignBody.name).toBe('deck (2).pdf')
    expect(second.presignBody.nodeId).not.toBe(first.presignBody.nodeId)
  })

  it('rejects a non-PDF mime type at presign with 415, before any URL is issued', async () => {
    const f = await fixture()
    await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/uploads/presign`)
      .set(f.auth)
      .send({
        parentId: f.rootId,
        name: 'notes.txt',
        sizeBytes: 10,
        mimeType: 'text/plain',
      })
      .expect(415)
  })

  it('answers a stranger with 404, never 403 — no grant must not confirm the room exists', async () => {
    const f = await fixture()
    const stranger = await createUser()
    await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/uploads/presign`)
      .set(await authFor(stranger))
      .send({
        parentId: f.rootId,
        name: 'x.pdf',
        sizeBytes: 10,
        mimeType: 'application/pdf',
      })
      .expect(404)
  })

  it('404s a presign whose parentId belongs to another room, creating nothing there', async () => {
    const f = await fixture()
    const other = await createUser()
    const otherRoom = await createRoom(other.id)

    await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/uploads/presign`)
      .set(f.auth)
      .send({
        parentId: otherRoom.rootId,
        name: 'smuggled.pdf',
        sizeBytes: 10,
        mimeType: 'application/pdf',
      })
      .expect(404)

    expect(
      await prisma.node.count({ where: { parentId: otherRoom.rootId } }),
    ).toBe(0)
  })

  it('404s a stranger confirming a foreign node, leaving it PENDING', async () => {
    const f = await fixture()
    const { presignBody } = await upload(f, 'target.pdf')
    await put(presignBody.uploadUrl, PDF)

    const stranger = await createUser()
    await request(app.getHttpServer())
      .post(`/uploads/${presignBody.nodeId}/confirm`)
      .set(await authFor(stranger))
      .send({ versionId: presignBody.versionId })
      .expect(404)

    const node = await prisma.node.findUniqueOrThrow({
      where: { id: presignBody.nodeId },
    })
    expect(node.status).toBe('PENDING')
    expect(node.currentVersionId).toBeNull()
    expect(node.deletedAt).toBeNull()
  })

  it('404s the owner of one room confirming a node of another', async () => {
    const fA = await fixture()
    const fB = await fixture()
    const { presignBody } = await upload(fB, 'theirs.pdf')
    await put(presignBody.uploadUrl, PDF)

    await request(app.getHttpServer())
      .post(`/uploads/${presignBody.nodeId}/confirm`)
      .set(fA.auth)
      .send({ versionId: presignBody.versionId })
      .expect(404)

    const node = await prisma.node.findUniqueOrThrow({
      where: { id: presignBody.nodeId },
    })
    expect(node.status).toBe('PENDING')
    expect(node.currentVersionId).toBeNull()
  })

  it('KEEP_BOTH suffixes past a FOLDER occupying the name — the unique index is type-agnostic', async () => {
    const f = await fixture()
    const root = await prisma.node.findUniqueOrThrow({
      where: { id: f.rootId },
    })
    await createFolder(root, 'deck.pdf', f.owner.id)

    const res = await upload(f, 'deck.pdf', PDF, 'KEEP_BOTH')
    expect(res.presign.status).toBe(201)
    expect(res.presignBody.name).toBe('deck (2).pdf')
  })

  it('rejects an over-cap declared size at presign with 413, before any node row exists', async () => {
    const f = await fixture()
    await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/uploads/presign`)
      .set(f.auth)
      .send({
        parentId: f.rootId,
        name: 'giant.pdf',
        sizeBytes: 50 * 1024 * 1024 + 1,
        mimeType: 'application/pdf',
      })
      .expect(413)

    expect(
      await prisma.node.count({
        where: { roomId: f.roomId, id: { not: f.rootId } },
      }),
    ).toBe(0)
  })
})
