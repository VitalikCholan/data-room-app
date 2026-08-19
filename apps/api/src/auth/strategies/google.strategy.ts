import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'
import { Strategy } from 'passport-google-oauth20'
import type { Profile } from 'passport-google-oauth20'
import { AppEnv } from '../../config/env'
import { DomainError } from '../../common/errors'

export type GoogleProfile = {
  googleId: string
  email: string
  name: string
  emailVerified: boolean
}

/**
 * `ConfigService.get` types `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` as
 * `string | undefined`, matching `AppEnv`'s optional fields — this is not a false
 * positive from the type checker. Runtime safety comes entirely from `AuthModule`,
 * which only ever constructs this provider when `googleEnabled` is true. The guard
 * below makes that invariant explicit and enforced rather than accidental, since the
 * `@nestjs/passport` mixin's constructor typing (a union of the strategy's overloaded
 * parameter tuples) is too loose to catch a missing credential on its own.
 */
function googleOptions(config: ConfigService<AppEnv, true>) {
  const clientID = config.get('GOOGLE_CLIENT_ID', { infer: true })
  const clientSecret = config.get('GOOGLE_CLIENT_SECRET', { infer: true })
  // Unreachable in practice: AuthModule registers this provider only when both are set.
  // Kept as a real check because the type system does not enforce it — ConfigService.get
  // returns `string | undefined` here, and the mixin's constructor typing is too loose to catch it.
  if (!clientID || !clientSecret) {
    throw new Error('GoogleStrategy constructed without Google credentials')
  }
  return {
    clientID,
    clientSecret,
    callbackURL: `${config.get('PUBLIC_APP_URL', { infer: true })}/api/auth/google/callback`,
    scope: ['email', 'profile'],
  }
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService<AppEnv, true>) {
    super(googleOptions(config))
  }

  validate(_at: string, _rt: string, profile: Profile): GoogleProfile {
    const email = profile.emails?.[0]?.value
    if (!email) {
      throw new DomainError(
        'INVALID_CREDENTIALS',
        'Google did not provide an email address for this account',
      )
    }
    return {
      googleId: profile.id,
      email,
      name: profile.displayName ?? email,
      // Google's own verification status, not ours: linking an unverified address to an
      // existing password account would let anyone claiming that address on Google
      // inherit the victim's account. `AuthService.upsertGoogleUser` enforces this.
      emailVerified: profile._json.email_verified ?? false,
    }
  }
}
