import { Module, Provider } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { AppEnv, googleEnabled } from '../config/env'
import { AuthService } from './auth.service'
import { AuthController } from './auth.controller'
import { GoogleController } from './google.controller'
import { TokensService } from './tokens.service'
import { JwtStrategy } from './strategies/jwt.strategy'
import { GoogleStrategy } from './strategies/google.strategy'

/** Exported for the unit test: the strategy must not be constructed without credentials. */
export function googleProviders(
  env: Pick<AppEnv, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>,
): Provider[] {
  return googleEnabled(env) ? [GoogleStrategy] : []
}

/**
 * Gated on raw `process.env`, not on `validateEnv`: this line runs at import time,
 * before `ConfigModule` loads `apps/api/.env`. `main.ts` imports `dotenv/config` as its
 * first statement, so the file is already in `process.env` by the time this module is
 * evaluated. Full validation still happens in `ConfigModule.forRoot({ validate: validateEnv })`.
 *
 * Computed once here and reused below for both `controllers` and `providers`, so the two
 * arrays are visibly in lockstep rather than each independently re-deriving the same
 * decision from `process.env`.
 */
const googleConfigured = googleEnabled(process.env)

@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: googleConfigured
    ? [AuthController, GoogleController]
    : [AuthController],
  providers: [
    AuthService,
    TokensService,
    JwtStrategy,
    ...(googleConfigured ? [GoogleStrategy] : []),
  ],
  exports: [AuthService, TokensService],
})
export class AuthModule {}
