import { googleEnabled, validateEnv } from './env'

const valid = {
  DATABASE_URL:
    'postgresql://dataroom:dataroom@localhost:5433/dataroom?schema=public',
  JWT_SECRET: 'a'.repeat(16),
  REFRESH_SECRET: 'b'.repeat(16),
  PUBLIC_APP_URL: 'http://localhost:5173',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'data-room',
  S3_ACCESS_KEY_ID: 'minioadmin',
  S3_SECRET_ACCESS_KEY: 'minioadmin',
}

describe('validateEnv', () => {
  it('accepts a minimal environment and applies defaults', () => {
    const env = validateEnv(valid)
    expect(env.NODE_ENV).toBe('development')
    expect(env.PORT).toBe(3000)
    expect(env.S3_REGION).toBe('us-east-1')
    expect(env.S3_FORCE_PATH_STYLE).toBe(true)
  })

  it('accepts localhost urls, which have no TLD', () => {
    expect(() => validateEnv(valid)).not.toThrow()
  })

  it('coerces the string PORT into a number', () => {
    expect(validateEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080)
  })

  it('coerces S3_FORCE_PATH_STYLE into a real boolean', () => {
    expect(
      validateEnv({ ...valid, S3_FORCE_PATH_STYLE: 'false' })
        .S3_FORCE_PATH_STYLE,
    ).toBe(false)
    expect(
      validateEnv({ ...valid, S3_FORCE_PATH_STYLE: 'true' })
        .S3_FORCE_PATH_STYLE,
    ).toBe(true)
  })

  it('names the offending key when a required value is missing', () => {
    const { DATABASE_URL, ...withoutDb } = valid
    expect(() => validateEnv(withoutDb)).toThrow(/DATABASE_URL/)
  })

  it('rejects a database url that is not postgres', () => {
    expect(() =>
      validateEnv({ ...valid, DATABASE_URL: 'mysql://localhost/db' }),
    ).toThrow(/DATABASE_URL/)
  })

  it('rejects a secret that is too short to be worth having', () => {
    expect(() => validateEnv({ ...valid, JWT_SECRET: 'short' })).toThrow(
      /JWT_SECRET/,
    )
  })

  it('rejects JWT_SECRET and REFRESH_SECRET being set to the same value', () => {
    expect(() =>
      validateEnv({ ...valid, REFRESH_SECRET: valid.JWT_SECRET }),
    ).toThrow(/JWT_SECRET.*REFRESH_SECRET/s)
  })
})

describe('googleEnabled', () => {
  it('treats empty strings as absent, matching .env.example', () => {
    expect(
      googleEnabled({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }),
    ).toBe(false)
  })

  it('requires both halves of the credential pair', () => {
    expect(
      googleEnabled({
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: undefined,
      }),
    ).toBe(false)
    expect(
      googleEnabled({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }),
    ).toBe(true)
  })
})
