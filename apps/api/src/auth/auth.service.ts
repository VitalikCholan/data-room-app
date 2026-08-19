import { Injectable, Logger } from '@nestjs/common'
import * as argon2 from 'argon2'
import { PrismaService } from '../prisma/prisma.service'
import { DomainError } from '../common/errors'
import { TokensService } from './tokens.service'
import { RegisterDto } from './dto/register.dto'
import { LoginDto } from './dto/login.dto'
import { Prisma } from '../generated/prisma/client'

export type AuthUser = { id: string; email: string; name: string }

/**
 * Computed once, at module load, and reused for every login attempt against a missing
 * user or a Google-only account. Without this, `!user?.passwordHash` short-circuits
 * before ever calling argon2, so a non-existent email returns after one DB round trip
 * while a real one pays a full argon2 verify — a timing side channel that lets an
 * attacker enumerate accounts despite the single shared error message and code.
 */
const dummyHash = argon2.hash('not-a-real-password-just-for-timing')

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase()
    if (await this.prisma.user.findUnique({ where: { email } })) {
      // A distinct code from NAME_CONFLICT (folder/file name collisions): a client
      // switching on `code` needs to tell "email taken" apart from "name taken".
      throw new DomainError(
        'EMAIL_TAKEN',
        'An account with this email already exists',
      )
    }
    try {
      const user = await this.prisma.user.create({
        data: {
          email,
          name: dto.name,
          passwordHash: await argon2.hash(dto.password),
        },
      })
      return this.issue(user)
    } catch (error) {
      // Two registrations can race past the findUnique above; the unique index is the
      // real authority, and the caller should see the same message either way.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new DomainError(
          'EMAIL_TAKEN',
          'An account with this email already exists',
        )
      }
      throw error
    }
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    })
    // One message for "no such user" and "wrong password" — no account enumeration.
    // Both branches also pay the same argon2 cost: a non-existent email or a
    // Google-only account verifies against the dummy hash instead of short-circuiting,
    // so the response time does not itself reveal which case occurred.
    const hash = user?.passwordHash ?? (await dummyHash)
    const valid = await argon2.verify(hash, dto.password)
    if (!user?.passwordHash || !valid) {
      throw new DomainError(
        'INVALID_CREDENTIALS',
        'Incorrect email or password',
      )
    }
    return this.issue(user)
  }

  async refresh(refreshToken: string | undefined) {
    if (!refreshToken)
      throw new DomainError('INVALID_CREDENTIALS', 'Missing refresh token')
    let sub: string
    try {
      sub = this.tokens.verifyRefresh(refreshToken).sub
    } catch (error) {
      // Debug, not warn/error: an expired refresh token is routine client behaviour, not
      // an operational problem. Logged rather than discarded so a malformed token and an
      // expired one are distinguishable when debugging, without changing the response.
      this.logger.debug(
        `Refresh token verification failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw new DomainError(
        'INVALID_CREDENTIALS',
        'Expired or invalid refresh token',
      )
    }
    const user = await this.prisma.user.findUnique({ where: { id: sub } })
    if (!user) throw new DomainError('INVALID_CREDENTIALS', 'Unknown account')
    return this.issue(user)
  }

  async upsertGoogleUser(profile: {
    googleId: string
    email: string
    name: string
    emailVerified: boolean
  }) {
    const email = profile.email.toLowerCase()

    // googleId is checked first, and on its own: a prior `findFirst` with an OR left it
    // undefined which row won registration when googleId belonged to one user and the
    // email to another, and updating the wrong one violated User_googleId_key.
    const byGoogleId = await this.prisma.user.findUnique({
      where: { googleId: profile.googleId },
    })
    if (byGoogleId) return this.issue(byGoogleId)

    const byEmail = await this.prisma.user.findUnique({ where: { email } })
    if (byEmail) {
      // The email belongs to a different Google account already — updating it here
      // would steal that account's googleId link (and fail the unique index anyway).
      if (byEmail.googleId && byEmail.googleId !== profile.googleId) {
        throw new DomainError(
          'EMAIL_TAKEN',
          'This email is linked to a different Google account',
        )
      }
      // Linking on email equality alone, without checking Google's verification, is the
      // canonical account-hijack pattern: sign in as the victim's address, inherit their
      // password account. Refuse instead of linking when Google has not verified it.
      if (!profile.emailVerified) {
        throw new DomainError(
          'EMAIL_TAKEN',
          'Google has not verified this email address, so it cannot be linked to an existing account',
        )
      }
      const linked = await this.prisma.user.update({
        where: { id: byEmail.id },
        data: { googleId: profile.googleId },
      })
      return this.issue(linked)
    }

    const created = await this.prisma.user.create({
      data: { email, name: profile.name, googleId: profile.googleId },
    })
    return this.issue(created)
  }

  private issue(user: { id: string; email: string; name: string }) {
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      } satisfies AuthUser,
      accessToken: this.tokens.signAccess(user.id),
      refreshToken: this.tokens.signRefresh(user.id),
    }
  }
}
