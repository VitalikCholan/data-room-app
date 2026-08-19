import { Injectable } from '@nestjs/common'
import * as argon2 from 'argon2'
import { PrismaService } from '../prisma/prisma.service'
import { DomainError } from '../common/errors'
import { TokensService } from './tokens.service'
import { RegisterDto } from './dto/register.dto'
import { LoginDto } from './dto/login.dto'
import { Prisma } from '../generated/prisma/client'

export type AuthUser = { id: string; email: string; name: string }

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase()
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new DomainError(
        'NAME_CONFLICT',
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
          'NAME_CONFLICT',
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
    if (
      !user?.passwordHash ||
      !(await argon2.verify(user.passwordHash, dto.password))
    ) {
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
    } catch {
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
  }) {
    const email = profile.email.toLowerCase()
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ googleId: profile.googleId }, { email }] },
    })
    const user = existing
      ? await this.prisma.user.update({
          where: { id: existing.id },
          data: { googleId: profile.googleId },
        })
      : await this.prisma.user.create({
          data: { email, name: profile.name, googleId: profile.googleId },
        })
    return this.issue(user)
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
