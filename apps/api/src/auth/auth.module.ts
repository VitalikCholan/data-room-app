import { Module, Provider, Type } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { googleEnabled } from '../config/env'
import { AuthService } from './auth.service'
import { AuthController } from './auth.controller'
import { GoogleController } from './google.controller'
import { TokensService } from './tokens.service'
import { JwtStrategy } from './strategies/jwt.strategy'
import { GoogleStrategy } from './strategies/google.strategy'

/** Exported for the unit test: the strategy must not be constructed without credentials. */
export function googleProviders(configured: boolean): Provider[] {
  return configured ? [GoogleStrategy] : []
}

/** Exported for the unit test: the route must not exist without credentials. */
export function googleControllers(configured: boolean): Type<unknown>[] {
  return configured ? [GoogleController] : []
}

/**
 * Gated on raw `process.env`, not on `validateEnv`: this line runs at import time,
 * before `ConfigModule` loads `apps/api/.env`. `main.ts` imports `dotenv/config` as its
 * first statement, so the file is already in `process.env` here. Full validation still
 * happens in `ConfigModule.forRoot({ validate: validateEnv })`.
 */
const googleConfigured = googleEnabled(process.env)

@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: [AuthController, ...googleControllers(googleConfigured)],
  providers: [
    AuthService,
    TokensService,
    JwtStrategy,
    ...googleProviders(googleConfigured),
  ],
  exports: [AuthService, TokensService],
})
export class AuthModule {}
