import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter'
import { PrismaService } from '../src/prisma/prisma.service'
import { randomUUID } from 'node:crypto'

describe('auth flow', () => {
  let app: INestApplication
  let prisma: PrismaService
  const email = `e2e-${randomUUID()}@t.io`

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = mod.createNestApplication()
    app.use(cookieParser())
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
    prisma = mod.get(PrismaService)
  })
  afterAll(() => app.close())

  it('registers, then reads /auth/me with the access token', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123', name: 'E2E' })
      .expect(201)
    expect(reg.body.accessToken).toBeTruthy()
    expect(reg.headers['set-cookie'].join()).toMatch(/refresh_token=.*HttpOnly/i)

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${reg.body.accessToken}`)
      .expect(200)
      .expect((r) => expect(r.body.email).toBe(email))
  })

  it('rejects /auth/me without a token', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401)
  })

  it('rejects a short password with 400 from validation', async () => {
    await request(app.getHttpServer()).post('/auth/register').send({ email: 'x@y.io', password: 'short', name: 'X' }).expect(400)
  })

  it('exchanges the refresh cookie for a new access token', async () => {
    const login = await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'password123' }).expect(201)
    const cookie = login.headers['set-cookie']
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .expect(201)
      .expect((r) => expect(r.body.accessToken).toBeTruthy())
  })

  it('rejects a token for a deleted user with 401', async () => {
    const staleEmail = `e2e-stale-${randomUUID()}@t.io`
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: staleEmail, password: 'password123', name: 'Stale' })
      .expect(201)
    const accessToken = reg.body.accessToken as string

    await prisma.user.delete({ where: { email: staleEmail } })

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401)
  })

  it('rejects /auth/refresh with no cookie at all', async () => {
    await request(app.getHttpServer()).post('/auth/refresh').expect(401)
  })

  it('rejects /auth/refresh with a syntactically invalid cookie value', async () => {
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', 'refresh_token=not-a-jwt')
      .expect(401)
  })

  it('clears the refresh cookie on logout so it can no longer be used to refresh', async () => {
    const login = await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'password123' }).expect(201)
    const loginCookie = login.headers['set-cookie']

    const logout = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', loginCookie)
      .expect(201)
    const logoutCookie = logout.headers['set-cookie'].join()
    expect(logoutCookie).toMatch(/refresh_token=;/)
    expect(logoutCookie).toMatch(/Expires=Thu, 01 Jan 1970/i)

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', logout.headers['set-cookie'])
      .expect(401)
  })
})
