import type { Profile } from 'passport-google-oauth20'
import { GoogleStrategy } from './google.strategy'
import { DomainError } from '../../common/errors'

describe('GoogleStrategy.validate', () => {
  it('rejects a Google profile with no email address, rather than merging accounts on an empty string', () => {
    const profile = { id: 'g1', displayName: 'A B' } as Profile
    let error: unknown
    try {
      GoogleStrategy.prototype.validate('at', 'rt', profile)
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({ code: 'INVALID_CREDENTIALS' })
  })
})
