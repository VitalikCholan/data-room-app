/** Mirrors the API's SAFE_NAME rule so the user hears about it before a round trip. */
const SLASH = /[/\\]/
/** Escaped, never literal: a raw control byte in source is invisible to review. */
// eslint-disable-next-line no-control-regex -- the control range is the check, not an accident
const CONTROL = /[\u0000-\u001f]/

export function validateNodeName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name cannot be empty'
  if (trimmed.length > 255) return 'Name must be 255 characters or fewer'
  if (SLASH.test(trimmed)) return 'Name cannot contain slashes'
  if (CONTROL.test(trimmed)) return 'Name cannot contain control characters'
  return null
}
