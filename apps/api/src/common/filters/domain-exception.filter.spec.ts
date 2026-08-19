import { DomainError } from '../errors'

describe('DomainError → HTTP status', () => {
  it.each([
    ['NOT_FOUND', 404],
    ['FORBIDDEN_ROLE', 403],
    ['GONE', 410],
    ['NAME_CONFLICT', 409],
    ['MOVE_CYCLE', 409],
    ['UPLOAD_NOT_FOUND', 409],
    ['TOO_LARGE', 413],
    ['UNSUPPORTED_TYPE', 415],
    ['VALIDATION', 422],
  ] as const)('maps %s to %i', (code, status) => {
    expect(new DomainError(code, 'msg').status).toBe(status)
  })

  it('carries a machine-readable code in the payload', () => {
    expect(
      new DomainError('NAME_CONFLICT', 'taken', {
        existingNodeId: 'n1',
      }).toPayload(),
    ).toEqual({
      code: 'NAME_CONFLICT',
      message: 'taken',
      details: { existingNodeId: 'n1' },
    })
  })
})
