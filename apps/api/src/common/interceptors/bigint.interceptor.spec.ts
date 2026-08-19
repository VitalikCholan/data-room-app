import { serializeBigInts } from './bigint.interceptor'

describe('serializeBigInts', () => {
  it('converts BigInt to number recursively', () => {
    expect(serializeBigInts({ a: 10n, b: [{ c: 2n }], d: 'x' })).toEqual({
      a: 10,
      b: [{ c: 2 }],
      d: 'x',
    })
  })

  it('leaves Date instances intact', () => {
    const d = new Date('2026-01-01T00:00:00.000Z')
    expect(serializeBigInts({ d }).d).toBeInstanceOf(Date)
  })

  it('handles null and undefined', () => {
    expect(serializeBigInts({ a: null, b: undefined })).toEqual({
      a: null,
      b: undefined,
    })
  })
})
