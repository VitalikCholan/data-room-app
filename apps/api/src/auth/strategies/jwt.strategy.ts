import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import type { Request } from 'express'
import { AppEnv } from '../../config/env'
import { PrismaService } from '../../prisma/prisma.service'
import { DomainError } from '../../common/errors'
import { AuthUser } from '../auth.service'

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<AppEnv, true>,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: Request) =>
          (req.cookies?.access_token as string | undefined) ?? null,
      ]),
      secretOrKey: config.get('JWT_SECRET', { infer: true }),
      // The attacker controls the token, not us — pin the algorithm on the verification
      // side (passport-jwt passes this straight through to jsonwebtoken.verify), closing
      // the same alg-confusion gap that tokens.service.ts already closes on sign/verify.
      algorithms: ['HS256'],
    })
  }

  async validate(payload: { sub: string }): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    })
    if (!user) throw new DomainError('INVALID_CREDENTIALS', 'Unknown account')
    return { id: user.id, email: user.email, name: user.name }
  }
}
