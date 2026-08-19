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

/**
 * `findUnique` is called twice inside `upsertGoogleUser` — once by googleId, once by
 * email — and each call needs a distinct answer, which the single-value `makePrisma`
 * mock above can't express.
 */
function makeGooglePrisma(users: {
  byGoogleId?: { id: string; googleId: string | null } | null
  byEmail?: { id: string; googleId: string | null } | null
}) {
  const findUnique = jest
    .fn()
    .mockImplementation(
      ({ where }: { where: { googleId?: string; email?: string } }) => {
        if (where.googleId !== undefined)
          return Promise.resolve(users.byGoogleId ?? null)
        if (where.email !== undefined)
          return Promise.resolve(users.byEmail ?? null)
        return Promise.resolve(null)
      },
    )
  const update = jest
    .fn()
    .mockImplementation(
      ({ where, data }: { where: { id: string }; data: object }) =>
        Promise.resolve({ ...users.byEmail, id: where.id, ...data }),
    )
  const create = jest
    .fn()
    .mockImplementation(({ data }: { data: object }) =>
      Promise.resolve({ id: 'new-user', ...data }),
    )
  return { user: { findUnique, update, create } } as never
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

  it('rejects a duplicate email with EMAIL_TAKEN', async () => {
    const svc = new AuthService(makePrisma({ id: 'u1' }), tokens)
    await expect(
      svc.register({ email: 'a@b.io', password: 'password123', name: 'A' }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' })
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

describe('AuthService.upsertGoogleUser', () => {
  const profile = { googleId: 'g1', email: 'a@b.io', name: 'A' }

  it('signs straight in on a googleId hit, without touching the email lookup', async () => {
    const prisma = makeGooglePrisma({
      byGoogleId: { id: 'u1', googleId: 'g1' },
    })
    const svc = new AuthService(prisma, tokens)
    const result = await svc.upsertGoogleUser({
      ...profile,
      emailVerified: false,
    })
    expect(result.user.id).toBe('u1')
    expect(
      (prisma as { user: { update: jest.Mock; create: jest.Mock } }).user
        .update,
    ).not.toHaveBeenCalled()
    expect(
      (prisma as { user: { update: jest.Mock; create: jest.Mock } }).user
        .create,
    ).not.toHaveBeenCalled()
  })

  it('links an unlinked account when Google reports the email verified', async () => {
    const prisma = makeGooglePrisma({
      byGoogleId: null,
      byEmail: { id: 'u2', googleId: null },
    })
    const svc = new AuthService(prisma, tokens)
    const result = await svc.upsertGoogleUser({
      ...profile,
      emailVerified: true,
    })
    expect(result.user.id).toBe('u2')
    expect(
      (prisma as { user: { update: jest.Mock } }).user.update,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u2' },
        data: { googleId: 'g1' },
      }),
    )
  })

  it('refuses to link when Google has not verified the email — the account-hijack path', async () => {
    const prisma = makeGooglePrisma({
      byGoogleId: null,
      byEmail: { id: 'u3', googleId: null },
    })
    const svc = new AuthService(prisma, tokens)
    await expect(
      svc.upsertGoogleUser({ ...profile, emailVerified: false }),
    ).rejects.toBeInstanceOf(DomainError)
    await expect(
      svc.upsertGoogleUser({ ...profile, emailVerified: false }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' })
    expect(
      (prisma as { user: { update: jest.Mock } }).user.update,
    ).not.toHaveBeenCalled()
  })

  it('refuses to relink an email that already belongs to a different Google account', async () => {
    const prisma = makeGooglePrisma({
      byGoogleId: null,
      byEmail: { id: 'u4', googleId: 'someone-elses-google-id' },
    })
    const svc = new AuthService(prisma, tokens)
    await expect(
      svc.upsertGoogleUser({ ...profile, emailVerified: true }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' })
    expect(
      (prisma as { user: { update: jest.Mock } }).user.update,
    ).not.toHaveBeenCalled()
  })
})
