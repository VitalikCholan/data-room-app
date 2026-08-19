import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { configureApp } from '../src/bootstrap'
import { createFile, createFolder, createUser, prisma } from './factories'
import { truncateDb } from './support/truncate-db'

// supertest types `Response.body` as `any`; these give the shapes this suite actually
// reads back so lint's typed rules can verify property access instead of everything
// being an unsafe `any`-typed operation — same pattern as auth.e2e-spec.ts.
type LoginBody = { accessToken: string }
type RoomBody = { id: string; name: string; rootNodeId: string }
type RoomListItem = RoomBody & {
  rollup: { folders: number; files: number; bytes: number }
}

describe('rooms', () => {
  let app: INestApplication
  let token: string
  let userId: string

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = mod.createNestApplication()
    configureApp(app)
    await app.init()

    const user = await createUser()
    userId = user.id
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
    token = (res.body as LoginBody).accessToken
  })
  afterAll(async () => {
    await truncateDb(prisma)
    await app.close()
    await prisma.$disconnect()
  })

  const auth = () => ({ Authorization: `Bearer ${token}` })

  it('creates a room together with its root node', async () => {
    const res = await request(app.getHttpServer())
      .post('/rooms')
      .set(auth())
      .send({ name: 'Project Titan' })
      .expect(201)
    const body = res.body as RoomBody
    expect(body).toMatchObject({ name: 'Project Titan' })
    const root = await prisma.node.findUniqueOrThrow({
      where: { id: body.rootNodeId },
    })
    expect(root).toMatchObject({
      parentId: null,
      path: '/',
      type: 'FOLDER',
      status: 'ACTIVE',
      name: 'Project Titan',
    })
  })

  it('lists only rooms owned by the caller, with a rollup', async () => {
    const created = await request(app.getHttpServer())
      .post('/rooms')
      .set(auth())
      .send({ name: 'With Content' })
      .expect(201)
    const createdBody = created.body as RoomBody
    const root = await prisma.node.findUniqueOrThrow({
      where: { id: createdBody.rootNodeId },
    })
    const sub = await createFolder(root, 'Financials', userId)
    await createFile(sub, 'a.pdf', userId, 2048)
    await createFile(root, 'b.pdf', userId, 1024)

    const otherUser = await createUser()
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: otherUser.email, password: otherUser.password })
      .then((r) =>
        request(app.getHttpServer())
          .post('/rooms')
          .set({ Authorization: `Bearer ${(r.body as LoginBody).accessToken}` })
          .send({ name: 'Not Mine' }),
      )

    const list = await request(app.getHttpServer())
      .get('/rooms')
      .set(auth())
      .expect(200)
    const rooms = list.body as RoomListItem[]
    const names = rooms.map((r) => r.name)
    expect(names).toContain('With Content')
    expect(names).not.toContain('Not Mine')

    const row = rooms.find((r) => r.name === 'With Content')
    expect(row?.rollup).toEqual({ folders: 1, files: 2, bytes: 3072 })
  })

  it('renames the room and its root node together', async () => {
    const created = await request(app.getHttpServer())
      .post('/rooms')
      .set(auth())
      .send({ name: 'Old' })
      .expect(201)
    const createdBody = created.body as RoomBody
    await request(app.getHttpServer())
      .patch(`/rooms/${createdBody.id}`)
      .set(auth())
      .send({ name: 'New' })
      .expect(200)
    const root = await prisma.node.findUniqueOrThrow({
      where: { id: createdBody.rootNodeId },
    })
    expect(root.name).toBe('New')
  })

  it('returns 404 when renaming someone else’s room', async () => {
    const stranger = await createUser()
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: stranger.email, password: stranger.password })
    const strangerToken = (loginRes.body as LoginBody).accessToken

    const mine = await request(app.getHttpServer())
      .post('/rooms')
      .set(auth())
      .send({ name: 'Private' })
      .expect(201)
    const mineBody = mine.body as RoomBody

    await request(app.getHttpServer())
      .patch(`/rooms/${mineBody.id}`)
      .set({ Authorization: `Bearer ${strangerToken}` })
      .send({ name: 'Hijacked' })
      .expect(404)
  })

  // Validation failures are 422: the global pipe's exceptionFactory raises
  // DomainError('VALIDATION'), which maps to 422, not the ValidationPipe's default 400.
  it('rejects an empty room name with 422', async () => {
    await request(app.getHttpServer())
      .post('/rooms')
      .set(auth())
      .send({ name: '' })
      .expect(422)
  })
})
