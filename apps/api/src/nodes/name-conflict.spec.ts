import { resolveAvailableName } from './name-conflict'

const taken = (...names: string[]) => new Set(names.map((n) => n.toLowerCase()))

describe('resolveAvailableName', () => {
  it('returns the desired name when free', () => {
    expect(resolveAvailableName('invoice.pdf', taken())).toBe('invoice.pdf')
  })

  it('appends (2) before the extension', () => {
    expect(resolveAvailableName('invoice.pdf', taken('invoice.pdf'))).toBe(
      'invoice (2).pdf',
    )
  })

  it('skips suffixes that are already taken', () => {
    expect(
      resolveAvailableName(
        'invoice.pdf',
        taken('invoice.pdf', 'invoice (2).pdf', 'invoice (3).pdf'),
      ),
    ).toBe('invoice (4).pdf')
  })

  it('is case-insensitive, matching the database index', () => {
    expect(resolveAvailableName('Invoice.PDF', taken('invoice.pdf'))).toBe(
      'Invoice (2).PDF',
    )
  })

  it('handles a name with no extension', () => {
    expect(resolveAvailableName('Board Minutes', taken('board minutes'))).toBe(
      'Board Minutes (2)',
    )
  })

  it('only splits on the final dot', () => {
    expect(resolveAvailableName('2023.Q4.pdf', taken('2023.q4.pdf'))).toBe(
      '2023.Q4 (2).pdf',
    )
  })
})
