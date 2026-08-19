import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { configureApp } from '../src/bootstrap'
import { PrismaService } from '../src/prisma/prisma.service'
import { truncateDb } from './support/truncate-db'
import { randomUUID } from 'node:crypto'

// supertest types `Response.body` as `any` and `Response.headers` as `{ [k: string]: string }`
// (even though Node returns `set-cookie` as a real string array at runtime) — these two
// helpers give the shapes this suite actually reads back, so lint's typed rules can verify
// property access instead of everything being an unsafe `any`/`error`-typed operation.
type AuthBody = {
  user: { id: string; email: string; name: string }
  accessToken: string
}
type MeBody = { user: AuthBody['user'] }
type ErrorBody = { code: string; message: string }
const setCookies = (headers: { [k: string]: string }): string[] =>
  headers['set-cookie'] as unknown as string[]

describe('auth flow', () => {
  let app: INestApplication
  let prisma: PrismaService
  const email = `e2e-${randomUUID()}@t.io`

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = mod.createNestApplication()
    configureApp(app)
    await app.init()
    prisma = mod.get(PrismaService)
  })
  afterAll(async () => {
    await truncateDb(prisma)
    await app.close()
  })

  it('registers, then reads /auth/me with the access token', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123', name: 'E2E' })
      .expect(201)
    const body = reg.body as AuthBody
    expect(body.accessToken).toBeTruthy()
    expect(setCookies(reg.headers).join()).toMatch(/refresh_token=.*HttpOnly/i)

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200)
      .expect((r) => expect((r.body as MeBody).user.email).toBe(email))
  })

  it('rejects /auth/me without a token', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401)
  })

  it('rejects a short password with 422 from validation, using the domain error envelope', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'x@y.io', password: 'short', name: 'X' })
      .expect(422)
    expect((res.body as ErrorBody).code).toBe('VALIDATION')
  })

  it('exchanges the refresh cookie for a new access token', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(201)
    const cookie = setCookies(login.headers).join('; ')
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .expect(201)
      .expect((r) => expect((r.body as AuthBody).accessToken).toBeTruthy())
  })

  it('rejects a refresh token presented as a bearer access token', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(201)
    const cookie = setCookies(login.headers).join()
    const refreshToken = /refresh_token=([^;]+)/.exec(cookie)?.[1]
    expect(refreshToken).toBeTruthy()

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${refreshToken}`)
      .expect(401)
  })

  it('rejects an access token presented as the refresh cookie', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(201)
    const accessToken = (login.body as AuthBody).accessToken

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', `refresh_token=${accessToken}`)
      .expect(401)
  })

  it('rejects a token for a deleted user with 401', async () => {
    const staleEmail = `e2e-stale-${randomUUID()}@t.io`
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: staleEmail, password: 'password123', name: 'Stale' })
      .expect(201)
    const accessToken = (reg.body as AuthBody).accessToken

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
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(201)
    const loginCookie = setCookies(login.headers).join('; ')

    const logout = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', loginCookie)
      .expect(201)
    const logoutCookie = setCookies(logout.headers).join()
    expect(logoutCookie).toMatch(/refresh_token=;/)
    expect(logoutCookie).toMatch(/Expires=Thu, 01 Jan 1970/i)

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', setCookies(logout.headers).join('; '))
      .expect(401)
  })

  it('does not register a Google route when Google is unconfigured', async () => {
    // This suite boots AppModule with empty GOOGLE_CLIENT_ID/SECRET (see apps/api/.env),
    // so the route must not exist at all — not redirect, not 401, but 404.
    await request(app.getHttpServer()).get('/auth/google').expect(404)
  })
})
