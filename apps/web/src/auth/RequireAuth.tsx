import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthProvider'
import { TableSkeleton } from '../components/Skeleton'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <TableSkeleton rows={4} />
  if (status === 'anonymous')
    return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />
  return <>{children}</>
}
