/* eslint-disable react-refresh/only-export-components -- messageForError intentionally lives beside the component that renders it */
import type { ReactNode } from 'react'
import { ApiError } from '../api/client'
import { Button } from './ui/button'

/** One place that turns an HTTP code into the wording agreed in the spec. */
export function messageForError(error: unknown): { title: string; hint: string } {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 404:
        return { title: 'Not found', hint: 'This item does not exist, or you do not have access to it.' }
      case 403:
        return { title: 'Read-only access', hint: 'You can view this item but not change it.' }
      case 410:
        return { title: 'No longer available', hint: error.message }
      case 401:
        return { title: 'Session expired', hint: 'Sign in again to continue.' }
      default:
        return { title: 'Something went wrong', hint: error.message }
    }
  }
  return { title: 'Something went wrong', hint: 'Please try again.' }
}

export function ErrorState({ error, onRetry, action }: { error: unknown; onRetry?: () => void; action?: ReactNode }) {
  const { title, hint } = messageForError(error)
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="max-w-sm text-sm text-subtle">{hint}</p>
      <div className="mt-2 flex gap-2">
        {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
        {action}
      </div>
    </div>
  )
}
