import { ApiError } from '../../api/client'

/**
 * Every 409 the move endpoint can raise — NAME_CONFLICT and MOVE_CYCLE — already carries
 * a sentence written for a person. Showing `error.message` is what keeps the code out of
 * the UI; the fallback is for the transport failing, which has no message worth repeating.
 */
export function moveFailureMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Could not move this item'
}
