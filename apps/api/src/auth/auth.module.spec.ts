import { googleEnabled } from '../config/env'
import { googleProviders } from './auth.module'

describe('Google strategy registration', () => {
  it('is disabled when credentials are absent, so the app still boots', () => {
    const env = { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }
    expect(googleEnabled(env)).toBe(false)
    expect(googleProviders(env)).toHaveLength(0)
  })

  it('is enabled only when both variables are present', () => {
    expect(
      googleEnabled({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: undefined }),
    ).toBe(false)
    expect(
      googleProviders({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' }),
    ).toHaveLength(1)
  })
})
