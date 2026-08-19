import { ancestorIds, childPath, isWithinSubtree, ROOT_PATH } from './node-path'

const ROOT = 'aaaaaaaa-0000-0000-0000-000000000001'
const FIN = 'bbbbbbbb-0000-0000-0000-000000000002'
const FY23 = 'cccccccc-0000-0000-0000-000000000003'

describe('childPath', () => {
  it('builds a root node child path', () => {
    expect(childPath({ id: ROOT, path: ROOT_PATH })).toBe(`/${ROOT}/`)
  })

  it('appends to a nested path', () => {
    expect(childPath({ id: FIN, path: `/${ROOT}/` })).toBe(`/${ROOT}/${FIN}/`)
  })
})

describe('ancestorIds', () => {
  it('returns an empty list for a root node', () => {
    expect(ancestorIds(ROOT_PATH)).toEqual([])
  })

  it('returns ancestors root-first', () => {
    expect(ancestorIds(`/${ROOT}/${FIN}/`)).toEqual([ROOT, FIN])
  })
})

describe('isWithinSubtree', () => {
  const subtreeRootPath = `/${ROOT}/`

  it('accepts the subtree root itself', () => {
    expect(
      isWithinSubtree({ id: FIN, path: subtreeRootPath }, FIN, subtreeRootPath),
    ).toBe(true)
  })

  it('accepts a descendant', () => {
    expect(
      isWithinSubtree(
        { id: FY23, path: `/${ROOT}/${FIN}/` },
        FIN,
        subtreeRootPath,
      ),
    ).toBe(true)
  })

  it('rejects a sibling', () => {
    const sibling = 'dddddddd-0000-0000-0000-000000000004'
    expect(
      isWithinSubtree({ id: sibling, path: `/${ROOT}/` }, FIN, subtreeRootPath),
    ).toBe(false)
  })

  it('rejects an ancestor', () => {
    expect(
      isWithinSubtree({ id: ROOT, path: ROOT_PATH }, FIN, subtreeRootPath),
    ).toBe(false)
  })
})
