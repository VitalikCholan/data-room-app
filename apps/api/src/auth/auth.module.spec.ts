import { googleEnabled } from '../config/env'
import { googleControllers, googleProviders } from './auth.module'

describe('Google strategy registration', () => {
  it('registers neither the strategy nor the controller when not configured', () => {
    expect(googleProviders(false)).toHaveLength(0)
    expect(googleControllers(false)).toHaveLength(0)
  })

  it('registers both the strategy and the controller when configured', () => {
    expect(googleProviders(true)).toHaveLength(1)
    expect(googleControllers(true)).toHaveLength(1)
  })

  it('does not consider a half-configured pair as enabled', () => {
    expect(
      googleEnabled({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: undefined }),
    ).toBe(false)
  })
})
