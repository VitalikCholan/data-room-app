import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { configureApp } from '../src/bootstrap'
import { hashShareToken } from '../src/access/share-token'
import { StorageService } from '../src/storage/storage.service'
import {
  createFile,
  createRoom,
  createShare,
  createUser,
  prisma,
} from './factories'
import { truncateDb } from './support/truncate-db'

const PDF = Buffer.from('%PDF-1.7\n% files e2e fixture\n')

type LoginBody = { accessToken: string }
type PresignBody = {
  nodeId: string
  versionId: string
  blobKey: string
  uploadUrl: string
}
type ErrorBody = { code: string }

describe('file content', () => {
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

  async function fixture() {
    const owner = await createUser()
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: owner.email, password: owner.password })
    const { accessToken } = loginRes.body as LoginBody
    const { roomId, rootId, root } = await createRoom(owner.id)
    return {
      owner,
      roomId,
      rootId,
      root,
      auth: { Authorization: `Bearer ${accessToken}` },
    }
  }

  /** Full presign → PUT → confirm flow, so the checksum recorded at confirm is real. */
  async function uploadFile(
    f: Awaited<ReturnType<typeof fixture>>,
    name: string,
    body = PDF,
  ) {
    const presign = await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/uploads/presign`)
      .set(f.auth)
      .send({
        parentId: f.rootId,
        name,
        sizeBytes: body.byteLength,
        mimeType: 'application/pdf',
      })
      .expect(201)
    const presignBody = presign.body as PresignBody
    const put = await fetch(presignBody.uploadUrl, {
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/pdf' },
    })
    expect(put.ok).toBe(true)
    await request(app.getHttpServer())
      .post(`/uploads/${presignBody.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presignBody.versionId })
      .expect(201)
    return presignBody
  }

  it('redirects to a short-lived presigned url rather than proxying bytes', async () => {
    const f = await fixture()
    const { nodeId } = await uploadFile(f, 'MSA.pdf')
    const res = await request(app.getHttpServer())
      .get(`/nodes/${nodeId}/content`)
      .set(f.auth)
      .expect(302)
    expect(res.headers.location).toContain('X-Amz-Signature')
    expect(res.headers.location).toContain('X-Amz-Expires=300')
  })

  it('lets a public-link guest view a file inside the shared subtree', async () => {
    const f = await fixture()
    const { nodeId } = await uploadFile(f, 'shared.pdf')
    const token = 'view-token'
    await createShare({
      nodeId: f.rootId,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })
    await request(app.getHttpServer())
      .get(`/nodes/${nodeId}/content`)
      .set({ 'X-Share-Token': token })
      .expect(302)
  })

  it('answers 410 GONE when the object was overwritten after confirm', async () => {
    // The presigned PUT stays valid after confirm, so the object can be silently
    // replaced. The stored checksum pins which bytes were verified — a mismatch
    // must never be served (Ruling 33).
    const f = await fixture()
    const { nodeId, blobKey } = await uploadFile(f, 'target.pdf')

    const { url } = await storage.presignPut(blobKey, 'application/pdf')
    const overwrite = await fetch(url, {
      method: 'PUT',
      body: Buffer.from('%PDF-1.7\n% different bytes entirely\n'),
      headers: { 'Content-Type': 'application/pdf' },
    })
    expect(overwrite.ok).toBe(true)

    const res = await request(app.getHttpServer())
      .get(`/nodes/${nodeId}/content`)
      .set(f.auth)
      .expect(410)
    expect((res.body as ErrorBody).code).toBe('GONE')
  })

  it('answers 410 GONE when the object is missing from storage', async () => {
    const f = await fixture()
    // Factory file: confirmed rows, but no object was ever uploaded to the bucket.
    const file = await createFile(
      { ...f.root, roomId: f.roomId },
      'phantom.pdf',
      f.owner.id,
    )
    const res = await request(app.getHttpServer())
      .get(`/nodes/${file.id}/content`)
      .set(f.auth)
      .expect(410)
    expect((res.body as ErrorBody).code).toBe('GONE')
  })

  it('returns 410 once the owner deletes the file under a guest', async () => {
    const f = await fixture()
    const { nodeId } = await uploadFile(f, 'doomed.pdf')
    const token = 'gone-view-token'
    await createShare({
      nodeId: f.rootId,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })
    await prisma.node.update({
      where: { id: nodeId },
      data: { deletedAt: new Date() },
    })
    await request(app.getHttpServer())
      .get(`/nodes/${nodeId}/content`)
      .set({ 'X-Share-Token': token })
      .expect(410)
  })

  it('returns 404 for content on a folder', async () => {
    const f = await fixture()
    await request(app.getHttpServer())
      .get(`/nodes/${f.rootId}/content`)
      .set(f.auth)
      .expect(404)
  })

  it('returns 404 for a file that has no confirmed version', async () => {
    const f = await fixture()
    const node = await prisma.node.create({
      data: {
        roomId: f.roomId,
        parentId: f.rootId,
        type: 'FILE',
        name: 'unconfirmed.pdf',
        path: `/${f.rootId}/`,
        status: 'ACTIVE',
        createdById: f.owner.id,
      },
    })
    await request(app.getHttpServer())
      .get(`/nodes/${node.id}/content`)
      .set(f.auth)
      .expect(404)
  })
})
