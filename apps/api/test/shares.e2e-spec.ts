import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { configureApp } from '../src/bootstrap'
import { hashShareToken } from '../src/access/share-token'
import {
  createFile,
  createFolder,
  createRoom,
  createUser,
  prisma,
} from './factories'
import { truncateDb } from './support/truncate-db'

type LoginBody = { accessToken: string }
type ShareBody = {
  share: {
    id: string
    granteeEmail: string | null
    granteeId: string | null
    revokedAt: string | null
  }
  token?: string
  url?: string
}

describe('sharing', () => {
  let app: INestApplication

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = mod.createNestApplication()
    configureApp(app)
    await app.init()
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
    const guest = await createUser()
    const { roomId, rootId, root } = await createRoom(owner.id)
    const legal = await createFolder({ ...root, roomId }, 'Legal', owner.id)
    const msa = await createFile(legal, 'MSA.pdf', owner.id)
    return {
      owner,
      guest,
      roomId,
      rootId,
      legal,
      msa,
      auth: await authFor(owner),
      guestAuth: await authFor(guest),
    }
  }

  it('creates a public link, returns the token once, and stores only its hash', async () => {
    const f = await fixture()
    const res = await request(app.getHttpServer())
      .post(`/nodes/${f.legal.id}/shares`)
      .set(f.auth)
      .send({ mode: 'PUBLIC_LINK' })
      .expect(201)
    const body = res.body as ShareBody

    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.url).toContain(`/s/${body.token}`)

    const stored = await prisma.share.findUniqueOrThrow({
      where: { id: body.share.id },
    })
    expect(stored.tokenHash).toBe(hashShareToken(body.token!))

    const listed = await request(app.getHttpServer())
      .get(`/nodes/${f.legal.id}/shares`)
      .set(f.auth)
      .expect(200)
    const [firstListed] = listed.body as Record<string, unknown>[]
    expect(firstListed).not.toHaveProperty('token')
    expect(firstListed).not.toHaveProperty('tokenHash')
  })

  it('bootstraps a guest from the token alone', async () => {
    const f = await fixture()
    const { token } = (
      await request(app.getHttpServer())
        .post(`/nodes/${f.legal.id}/shares`)
        .set(f.auth)
        .send({ mode: 'PUBLIC_LINK' })
    ).body as ShareBody

    const res = await request(app.getHttpServer())
      .get(`/shared/${token}`)
      .expect(200)
    expect(res.body).toMatchObject({
      role: 'VIEWER',
      node: { id: f.legal.id, type: 'FOLDER' },
      roomId: f.roomId,
    })
  })

  it('lets the token holder list the shared folder but nothing above it', async () => {
    const f = await fixture()
    const { token } = (
      await request(app.getHttpServer())
        .post(`/nodes/${f.legal.id}/shares`)
        .set(f.auth)
        .send({ mode: 'PUBLIC_LINK' })
    ).body as ShareBody

    await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes?parentId=${f.legal.id}`)
      .set({ 'X-Share-Token': token! })
      .expect(200)
      .expect((r) =>
        expect(
          (r.body as { items: { name: string }[] }).items.map((i) => i.name),
        ).toEqual(['MSA.pdf']),
      )

    await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes?parentId=${f.rootId}`)
      .set({ 'X-Share-Token': token! })
      .expect(404)
  })

  it('grants a named user access by email and shows it under shared-with-me', async () => {
    const f = await fixture()
    await request(app.getHttpServer())
      .post(`/nodes/${f.legal.id}/shares`)
      .set(f.auth)
      .send({ mode: 'USER', email: f.guest.email.toUpperCase() })
      .expect(201)

    const mine = await request(app.getHttpServer())
      .get('/rooms/shared-with-me')
      .set(f.guestAuth)
      .expect(200)
    const [firstShared] = mine.body as Record<string, unknown>[]
    expect(firstShared).toMatchObject({
      nodeId: f.legal.id,
      nodeName: 'Legal',
      isWholeRoom: false,
    })
  })

  it('accepts an invite for an address with no account yet', async () => {
    const f = await fixture()
    const res = await request(app.getHttpServer())
      .post(`/nodes/${f.legal.id}/shares`)
      .set(f.auth)
      .send({ mode: 'USER', email: 'future-hire@example.com' })
      .expect(201)
    expect((res.body as ShareBody).share).toMatchObject({
      granteeEmail: 'future-hire@example.com',
      granteeId: null,
    })
  })

  it('re-inviting the same address updates the existing grant instead of failing', async () => {
    const f = await fixture()
    const first = await request(app.getHttpServer())
      .post(`/nodes/${f.legal.id}/shares`)
      .set(f.auth)
      .send({ mode: 'USER', email: f.guest.email })
      .expect(201)
    const firstBody = first.body as ShareBody
    await request(app.getHttpServer())
      .delete(`/shares/${firstBody.share.id}`)
      .set(f.auth)
      .expect(200)

    const second = await request(app.getHttpServer())
      .post(`/nodes/${f.legal.id}/shares`)
      .set(f.auth)
      .send({ mode: 'USER', email: f.guest.email })
      .expect(201)
    const secondBody = second.body as ShareBody
    expect(secondBody.share.id).toBe(firstBody.share.id)
    expect(secondBody.share.revokedAt).toBeNull()
  })

  it('revocation makes the link return 410, not 404', async () => {
    const f = await fixture()
    const created = await request(app.getHttpServer())
      .post(`/nodes/${f.legal.id}/shares`)
      .set(f.auth)
      .send({ mode: 'PUBLIC_LINK' })
      .expect(201)
    const createdBody = created.body as ShareBody
    await request(app.getHttpServer())
      .delete(`/shares/${createdBody.share.id}`)
      .set(f.auth)
      .expect(200)

    await request(app.getHttpServer())
      .get(`/shared/${createdBody.token}`)
      .expect(410)
    await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes?parentId=${f.legal.id}`)
      .set({ 'X-Share-Token': createdBody.token! })
      .expect(404)
  })

  it('returns 404 for a token that never existed', async () => {
    await request(app.getHttpServer())
      .get('/shared/definitely-not-a-real-token')
      .expect(404)
  })

  it('returns 410 when the shared node itself was deleted', async () => {
    const f = await fixture()
    const created = await request(app.getHttpServer())
      .post(`/nodes/${f.legal.id}/shares`)
      .set(f.auth)
      .send({ mode: 'PUBLIC_LINK' })
      .expect(201)
    await prisma.node.update({
      where: { id: f.legal.id },
      data: { deletedAt: new Date() },
    })
    await request(app.getHttpServer())
      .get(`/shared/${(created.body as ShareBody).token}`)
      .expect(410)
  })

  it('refuses share creation from a viewer with 403', async () => {
    const f = await fixture()
    const created = await request(app.getHttpServer())
      .post(`/nodes/${f.legal.id}/shares`)
      .set(f.auth)
      .send({ mode: 'PUBLIC_LINK' })
      .expect(201)
    await request(app.getHttpServer())
      .post(`/nodes/${f.msa.id}/shares`)
      .set({ 'X-Share-Token': (created.body as ShareBody).token! })
      .send({ mode: 'PUBLIC_LINK' })
      .expect(403)
  })

  it('refuses revocation by anyone but the room owner, with 404', async () => {
    const f = await fixture()
    const created = await request(app.getHttpServer())
      .post(`/nodes/${f.legal.id}/shares`)
      .set(f.auth)
      .send({ mode: 'PUBLIC_LINK' })
      .expect(201)
    await request(app.getHttpServer())
      .delete(`/shares/${(created.body as ShareBody).share.id}`)
      .set(f.guestAuth)
      .expect(404)
  })
})
