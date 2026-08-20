import { generateShareToken, hashShareToken } from './share-token'

describe('share tokens', () => {
  it('generates a url-safe token and a matching hash', () => {
    const { token, tokenHash } = generateShareToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(tokenHash).toBe(hashShareToken(token))
  })

  it('hashes deterministically, so lookup by hash is a single indexed query', () => {
    expect(hashShareToken('abc')).toBe(hashShareToken('abc'))
    expect(hashShareToken('abc')).not.toBe(hashShareToken('abd'))
  })

  it('never returns the raw token from the hash', () => {
    const { token, tokenHash } = generateShareToken()
    expect(tokenHash).not.toContain(token)
  })
})
