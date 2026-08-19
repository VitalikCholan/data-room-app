import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'
import { Strategy } from 'passport-google-oauth20'
import type { Profile } from 'passport-google-oauth20'
import { AppEnv } from '../../config/env'

export type GoogleProfile = { googleId: string; email: string; name: string }

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService<AppEnv, true>) {
    super({
      clientID: config.get('GOOGLE_CLIENT_ID', { infer: true }),
      clientSecret: config.get('GOOGLE_CLIENT_SECRET', { infer: true }),
      callbackURL: `${config.get('PUBLIC_APP_URL', { infer: true })}/api/auth/google/callback`,
      scope: ['email', 'profile'],
    })
  }

  validate(_at: string, _rt: string, profile: Profile): GoogleProfile {
    return {
      googleId: profile.id,
      email: profile.emails?.[0]?.value ?? '',
      name: profile.displayName ?? profile.emails?.[0]?.value ?? 'User',
    }
  }
}
