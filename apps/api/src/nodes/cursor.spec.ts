import { decodeCursor, encodeCursor } from './cursor'
import { DomainError } from '../common/errors'

describe('keyset cursor', () => {
  it('round-trips a sort key and id', () => {
    const c = { key: 'FY23 Report.pdf', id: 'abc-123' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('survives keys containing separators and unicode', () => {
    const c = { key: 'a/b:c—ü.pdf', id: 'id-1' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('round-trips an ISO timestamp key, so date sorting shares one cursor shape', () => {
    const c = { key: '2026-08-19T10:00:00.000Z', id: 'id-2' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('rejects a malformed cursor with VALIDATION rather than crashing', () => {
    expect(() => decodeCursor('not-base64!!')).toThrow(DomainError)
    expect(() =>
      decodeCursor(Buffer.from('no-separator').toString('base64url')),
    ).toThrow(DomainError)
  })
})
