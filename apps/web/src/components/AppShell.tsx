import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button } from './ui/button'
import { useAuth } from '../auth/AuthProvider'

export function AppShell({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const { user, logout } = useAuth()
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-border bg-surface px-4">
        <Link to="/" className="text-sm font-semibold">
          Data Room
        </Link>
        <div className="flex-1">{right}</div>
        {user ? (
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-subtle sm:inline">{user.email}</span>
            <Button size="sm" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        ) : null}
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}
