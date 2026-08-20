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
type VersionBody = { id: string; versionNo: number; isCurrent: boolean }

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

  /** A real presign → PUT → confirm re-upload, so v2 carries a genuine checksum too. */
  async function uploadNewVersion(
    f: Awaited<ReturnType<typeof fixture>>,
    name: string,
    body: Buffer,
  ) {
    const presign = await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/uploads/presign`)
      .set(f.auth)
      .send({
        parentId: f.rootId,
        name,
        sizeBytes: body.byteLength,
        mimeType: 'application/pdf',
        onConflict: 'NEW_VERSION',
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

  it('lists versions newest first, hiding unconfirmed reservations', async () => {
    const f = await fixture()
    const v1 = await uploadFile(f, 'history.pdf')
    const v2 = await uploadNewVersion(
      f,
      'history.pdf',
      Buffer.from('%PDF-1.7\n% second revision\n'),
    )
    // A third presign that never gets a PUT: a reservation, not history.
    await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/uploads/presign`)
      .set(f.auth)
      .send({
        parentId: f.rootId,
        name: 'history.pdf',
        sizeBytes: 10,
        mimeType: 'application/pdf',
        onConflict: 'NEW_VERSION',
      })
      .expect(201)

    const res = await request(app.getHttpServer())
      .get(`/nodes/${v1.nodeId}/versions`)
      .set(f.auth)
      .expect(200)

    const body = res.body as VersionBody[]
    expect(body.map((v) => v.versionNo)).toEqual([2, 1])
    expect(body[0]).toMatchObject({ id: v2.versionId, isCurrent: true })
    expect(body[1]).toMatchObject({ id: v1.versionId, isCurrent: false })
  })

  it('restore appends the old version forward and its content is still served', async () => {
    // The append must copy checksum along with blobKey: without it the Ruling 33
    // ETag comparison sees a null checksum on a live object and, worse, a restored
    // file whose bytes were never re-verified. Fetching the content afterwards is
    // the assertion that matters — a 410 here means restore broke the check.
    const f = await fixture()
    const v1 = await uploadFile(f, 'msa.pdf')
    await uploadNewVersion(
      f,
      'msa.pdf',
      Buffer.from('%PDF-1.7\n% unwanted revision\n'),
    )

    await request(app.getHttpServer())
      .post(`/nodes/${v1.nodeId}/versions/${v1.versionId}/restore`)
      .set(f.auth)
      .expect(201)

    const source = await prisma.fileVersion.findUniqueOrThrow({
      where: { id: v1.versionId },
    })
    const versions = await prisma.fileVersion.findMany({
      where: { nodeId: v1.nodeId },
      orderBy: { versionNo: 'desc' },
    })
    expect(versions[0].versionNo).toBe(3)
    expect(versions[0].blobKey).toBe(source.blobKey)
    expect(versions[0].checksum).toBe(source.checksum)
    expect(versions[0].checksum).not.toBeNull()

    const node = await prisma.node.findUniqueOrThrow({
      where: { id: v1.nodeId },
    })
    expect(node.currentVersionId).toBe(versions[0].id)
    expect(node.sizeBytes).toBe(source.sizeBytes)

    await request(app.getHttpServer())
      .get(`/nodes/${v1.nodeId}/content`)
      .set(f.auth)
      .expect(302)
  })

  it('a restored version still refuses bytes that no longer match what was verified', async () => {
    // The mirror of the test above, and the one that proves restore *armed* the check
    // rather than merely surviving it: if the appended version had carried a null
    // checksum, an overwritten object would be served happily (302) instead of 410.
    const f = await fixture()
    const v1 = await uploadFile(f, 'tamper.pdf')
    await uploadNewVersion(f, 'tamper.pdf', Buffer.from('%PDF-1.7\n% v2\n'))
    await request(app.getHttpServer())
      .post(`/nodes/${v1.nodeId}/versions/${v1.versionId}/restore`)
      .set(f.auth)
      .expect(201)

    const { url } = await storage.presignPut(v1.blobKey, 'application/pdf')
    const overwrite = await fetch(url, {
      method: 'PUT',
      body: Buffer.from('%PDF-1.7\n% swapped after the restore\n'),
      headers: { 'Content-Type': 'application/pdf' },
    })
    expect(overwrite.ok).toBe(true)

    const res = await request(app.getHttpServer())
      .get(`/nodes/${v1.nodeId}/content`)
      .set(f.auth)
      .expect(410)
    expect((res.body as ErrorBody).code).toBe('GONE')
  })

  it('refuses restore from a read-only viewer with 403', async () => {
    const f = await fixture()
    const v1 = await uploadFile(f, 'readonly.pdf')
    await uploadNewVersion(
      f,
      'readonly.pdf',
      Buffer.from('%PDF-1.7\n% newer\n'),
    )
    const token = 'ro-token'
    await createShare({
      nodeId: f.rootId,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })
    await request(app.getHttpServer())
      .post(`/nodes/${v1.nodeId}/versions/${v1.versionId}/restore`)
      .set({ 'X-Share-Token': token })
      .expect(403)
  })

  it('refuses restoring the version that is already current with 422', async () => {
    const f = await fixture()
    const v1 = await uploadFile(f, 'already.pdf')
    await request(app.getHttpServer())
      .post(`/nodes/${v1.nodeId}/versions/${v1.versionId}/restore`)
      .set(f.auth)
      .expect(422)
  })

  it('serves an explicit ?version= for an older version', async () => {
    const f = await fixture()
    const v1 = await uploadFile(f, 'pinned.pdf')
    await uploadNewVersion(f, 'pinned.pdf', Buffer.from('%PDF-1.7\n% newer\n'))

    const res = await request(app.getHttpServer())
      .get(`/nodes/${v1.nodeId}/content?version=${v1.versionId}`)
      .set(f.auth)
      .expect(302)
    expect(res.headers.location).toContain(v1.blobKey)
  })

  it('404s a ?version= that belongs to another node', async () => {
    const f = await fixture()
    const mine = await uploadFile(f, 'mine.pdf')
    const theirs = await uploadFile(f, 'theirs.pdf')

    await request(app.getHttpServer())
      .get(`/nodes/${mine.nodeId}/content?version=${theirs.versionId}`)
      .set(f.auth)
      .expect(404)
  })

  it('404s a ?version= that is an unconfirmed reservation', async () => {
    const f = await fixture()
    const v1 = await uploadFile(f, 'reserved.pdf')
    const reservation = await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/uploads/presign`)
      .set(f.auth)
      .send({
        parentId: f.rootId,
        name: 'reserved.pdf',
        sizeBytes: 10,
        mimeType: 'application/pdf',
        onConflict: 'NEW_VERSION',
      })
      .expect(201)

    await request(app.getHttpServer())
      .get(
        `/nodes/${v1.nodeId}/content?version=${(reservation.body as PresignBody).versionId}`,
      )
      .set(f.auth)
      .expect(404)
  })

  it('404s versions on a folder', async () => {
    const f = await fixture()
    await request(app.getHttpServer())
      .get(`/nodes/${f.rootId}/versions`)
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
