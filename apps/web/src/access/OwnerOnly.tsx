import type { ReactNode } from 'react'
import { useAccess } from './AccessProvider'

/**
 * The single place that asks "may this caller mutate". Every mutation control is
 * wrapped in it, so a VIEWER never renders one — there is no `if (isGuest)` anywhere
 * else in the browser.
 */
export function OwnerOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const { isOwner } = useAccess()
  return isOwner ? <>{children}</> : <>{fallback}</>
}
