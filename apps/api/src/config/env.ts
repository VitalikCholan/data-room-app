import { plainToInstance, Transform, Type } from 'class-transformer'
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MinLength,
  validateSync,
} from 'class-validator'

/**
 * One validation library for the whole application: the same decorators that guard
 * request DTOs guard the environment.
 */
export class AppEnv {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development'

  @Type(() => Number)
  @IsInt()
  PORT = 3000

  // IsUrl rejects the postgresql:// scheme, so the shape is asserted directly.
  @Matches(/^postgres(ql)?:\/\/.+/, {
    message: 'must be a postgres connection string',
  })
  DATABASE_URL: string

  @IsString()
  @MinLength(16, { message: 'must be at least 16 characters' })
  JWT_SECRET: string

  @IsString()
  @MinLength(16, { message: 'must be at least 16 characters' })
  REFRESH_SECRET: string

  // require_tld: false — otherwise http://localhost:5173 fails validation in development.
  @IsUrl({ require_tld: false })
  PUBLIC_APP_URL: string

  @IsUrl({ require_tld: false })
  S3_ENDPOINT: string

  @IsString()
  @MinLength(1)
  S3_BUCKET: string

  @IsString()
  S3_REGION = 'us-east-1'

  @IsString()
  @MinLength(1)
  S3_ACCESS_KEY_ID: string

  @IsString()
  @MinLength(1)
  S3_SECRET_ACCESS_KEY: string

  // Env values are always strings; this is the only coercion that is not a number.
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  S3_FORCE_PATH_STYLE = true

  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_ID?: string

  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_SECRET?: string
}

/** Fails fast at boot rather than at the first request that needs a missing key. */
export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const env = plainToInstance(AppEnv, raw, { exposeDefaultValues: true })
  const errors = validateSync(env, { skipMissingProperties: false })
  if (errors.length) {
    const detail = errors
      .map(
        (error) =>
          `  ${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`,
      )
      .join('\n')
    throw new Error(`Invalid environment:\n${detail}`)
  }
  // Per-field validation can't see across fields. If an operator sets JWT_SECRET and
  // REFRESH_SECRET to the same value, the two-token design silently collapses: an access
  // token becomes a valid refresh token and vice versa, and nothing else would catch it.
  if (env.JWT_SECRET === env.REFRESH_SECRET) {
    throw new Error(
      'Invalid environment:\n  JWT_SECRET and REFRESH_SECRET must not be the same value',
    )
  }
  return env
}

/** An empty string counts as absent, which is how .env.example ships it. */
export const googleEnabled = (
  env: Pick<AppEnv, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>,
) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
