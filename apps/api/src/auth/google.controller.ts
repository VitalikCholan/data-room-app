import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ConfigService } from '@nestjs/config'
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Request, Response } from 'express'
import { AppEnv } from '../config/env'
import { AuthService } from './auth.service'
import { TokensService } from './tokens.service'
import { GoogleProfile } from './strategies/google.strategy'

@ApiTags('auth')
@Controller('auth/google')
export class GoogleController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  @Get()
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Start Google sign-in (redirects to Google)' })
  start() {
    /* Passport redirects. */
  }

  @Get('callback')
  @UseGuards(AuthGuard('google'))
  @ApiExcludeEndpoint()
  async callback(@Req() req: Request, @Res() res: Response) {
    const { accessToken, refreshToken } = await this.auth.upsertGoogleUser(
      req.user as GoogleProfile,
    )
    this.tokens.setRefreshCookie(res, refreshToken)
    // The SPA reads the access token from the fragment, then replaces history.
    res.redirect(
      `${this.config.get('PUBLIC_APP_URL', { infer: true })}/auth/callback#access_token=${accessToken}`,
    )
  }
}
