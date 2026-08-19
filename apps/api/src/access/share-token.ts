import { createHash, randomBytes } from 'node:crypto'

/**
 * Only the hash is persisted. Because the token is random, the hash is still a
 * single indexed lookup — but a database dump no longer hands out live links.
 */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function generateShareToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenHash: hashShareToken(token) }
}
