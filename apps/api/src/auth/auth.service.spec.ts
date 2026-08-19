import { AuthService } from './auth.service'
import { DomainError } from '../common/errors'
import * as argon2 from 'argon2'

const tokens = {
  signAccess: () => 'access-token',
  signRefresh: () => 'refresh-token',
} as never

function makePrisma(user: unknown) {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      create: jest
        .fn()
        .mockImplementation(({ data }: never) =>
          Promise.resolve({ id: 'u1', ...data }),
        ),
    },
  } as never
}

describe('AuthService', () => {
  it('lower-cases the email on register so lookups are stable', async () => {
    const prisma = makePrisma(null)
    const svc = new AuthService(prisma, tokens)
    await svc.register({
      email: 'MiXeD@Case.IO',
      password: 'password123',
      name: 'A',
    })
    expect(
      (prisma as { user: { create: jest.Mock } }).user.create,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        // @jest/expect types this call `any`; the assertion itself is still fully typed.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({ email: 'mixed@case.io' }),
      }),
    )
  })

  it('rejects a duplicate email with 409', async () => {
    const svc = new AuthService(makePrisma({ id: 'u1' }), tokens)
    await expect(
      svc.register({ email: 'a@b.io', password: 'password123', name: 'A' }),
    ).rejects.toBeInstanceOf(DomainError)
  })

  it('rejects a wrong password with INVALID_CREDENTIALS', async () => {
    const hash = await argon2.hash('correct-horse')
    const svc = new AuthService(
      makePrisma({ id: 'u1', email: 'a@b.io', name: 'A', passwordHash: hash }),
      tokens,
    )
    await expect(
      svc.login({ email: 'a@b.io', password: 'wrong' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
  })

  it('rejects login for a Google-only account with no password set', async () => {
    const svc = new AuthService(
      makePrisma({ id: 'u1', email: 'a@b.io', name: 'A', passwordHash: null }),
      tokens,
    )
    await expect(
      svc.login({ email: 'a@b.io', password: 'anything' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
  })
})
