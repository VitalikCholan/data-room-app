import { ApiError } from '../api/client'

/**
 * The spec's wording, in one place: 410 is "it went away", anything else is "it never
 * was". A terminal screen on purpose — there is no Try again, because nothing the reader
 * can do will change the answer, and a retry button on a revoked link is a lie.
 */
export function GuestGoneState({ error }: { error: unknown }) {
  const isGone = error instanceof ApiError && error.status === 410
  // For a 410 the API's own sentence distinguishes a revoked link from a deleted item,
  // which is exactly the difference the reader needs.
  const title = isGone ? error.message : 'This link is not valid'
  const hint = isGone
    ? 'Ask the person who shared it to send a new link.'
    : 'Check that you copied the whole link, or ask for a new one.'

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="max-w-sm text-sm text-subtle">{hint}</p>
    </main>
  )
}
