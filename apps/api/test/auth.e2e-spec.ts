import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter'
import { randomUUID } from 'node:crypto'

describe('auth flow', () => {
  let app: INestApplication
  const email = `e2e-${randomUUID()}@t.io`

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = mod.createNestApplication()
    app.use(cookieParser())
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
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
})
