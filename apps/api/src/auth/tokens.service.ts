import { Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import { Response } from 'express'
import { AppEnv } from '../config/env'

export const REFRESH_COOKIE = 'refresh_token'

@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  signAccess(sub: string) {
    return this.jwt.sign(
      { sub },
      {
        secret: this.config.get('JWT_SECRET', { infer: true }),
        expiresIn: '15m',
      },
    )
  }

  signRefresh(sub: string) {
    return this.jwt.sign(
      { sub },
      {
        secret: this.config.get('REFRESH_SECRET', { infer: true }),
        expiresIn: '7d',
      },
    )
  }

  verifyRefresh(token: string): { sub: string } {
    return this.jwt.verify(token, {
      secret: this.config.get('REFRESH_SECRET', { infer: true }),
    })
  }

  /**
   * SameSite=Lax is safe because the browser always reaches the API through the
   * Vercel /api rewrite, making every request first-party.
   */
  setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.config.get('NODE_ENV', { infer: true }) === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })
  }

  clearRefreshCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, { path: '/' })
  }
}
