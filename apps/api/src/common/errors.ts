export type ErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN_ROLE'
  | 'GONE'
  | 'NAME_CONFLICT'
  | 'NOT_VERSIONABLE'
  | 'MOVE_CYCLE'
  | 'INVALID_TARGET'
  | 'UPLOAD_NOT_FOUND'
  | 'EMPTY_UPLOAD'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'VALIDATION'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_TAKEN'

const STATUS: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  FORBIDDEN_ROLE: 403,
  GONE: 410,
  NAME_CONFLICT: 409,
  NOT_VERSIONABLE: 409,
  MOVE_CYCLE: 409,
  INVALID_TARGET: 409,
  UPLOAD_NOT_FOUND: 409,
  EMPTY_UPLOAD: 422,
  TOO_LARGE: 413,
  UNSUPPORTED_TYPE: 415,
  VALIDATION: 422,
  INVALID_CREDENTIALS: 401,
  EMAIL_TAKEN: 409,
}

export class DomainError extends Error {
  readonly status: number
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.status = STATUS[code]
  }

  toPayload() {
    return { code: this.code, message: this.message, details: this.details }
  }
}

/** A node the caller may not see is reported as absent, never as forbidden. */
export const notFound = () =>
  new DomainError('NOT_FOUND', 'Not found or you do not have access')
