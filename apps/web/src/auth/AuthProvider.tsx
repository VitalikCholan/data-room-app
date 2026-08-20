/* eslint-disable react-refresh/only-export-components -- useAuth is the companion hook of this provider */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, onUnauthenticated, setAccessToken } from '../api/client'

export type SessionUser = { id: string; email: string; name: string }
type SessionResponse = { user: SessionUser; accessToken: string }
type Status = 'loading' | 'authenticated' | 'anonymous'

type AuthValue = {
  user: SessionUser | null
  status: Status
  login: (input: { email: string; password: string }) => Promise<void>
  register: (input: { email: string; password: string; name: string }) => Promise<void>
  logout: () => Promise<void>
  adoptSession: (session: SessionResponse) => void
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const navigate = useNavigate()

  /**
   * The share token is deliberately left alone. `useShareSession` on `/s/:token` is its
   * only writer, and this runs while that route may be mounted: the refresh at startup
   * resolves *after* the guest view has begun, so clearing it here used to hand a
   * signed-in owner the owner's own view of a link they meant to preview — and, worse,
   * hid it behind a race. A guest who signs in has already left the share route, whose
   * cleanup cleared the token on the way out.
   */
  const adoptSession = useCallback((session: SessionResponse) => {
    setAccessToken(session.accessToken)
    setUser(session.user)
    setStatus('authenticated')
  }, [])

  // The access token lives in memory only. On a reload the refresh cookie is what
  // restores the session, so a hard refresh does not sign the user out.
  useEffect(() => {
    let cancelled = false
    void api
      .post<SessionResponse>('/auth/refresh')
      .then((session) => {
        if (!cancelled) adoptSession(session)
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null)
          setStatus('anonymous')
        }
      })
    return () => {
      cancelled = true
    }
  }, [adoptSession])

  useEffect(() => {
    onUnauthenticated(() => {
      setUser(null)
      setStatus('anonymous')
      navigate(`/login?returnTo=${encodeURIComponent(window.location.pathname)}`, { replace: true })
    })
  }, [navigate])

  const value = useMemo<AuthValue>(
    () => ({
      user,
      status,
      adoptSession,
      login: async (input) => adoptSession(await api.post<SessionResponse>('/auth/login', input)),
      register: async (input) => adoptSession(await api.post<SessionResponse>('/auth/register', input)),
      logout: async () => {
        await api.post('/auth/logout').catch((error) => {
          // A failed logout must still clear the client: the cookie is gone either way.
          if (!(error instanceof ApiError)) throw error
        })
        setAccessToken(null)
        setUser(null)
        setStatus('anonymous')
      },
    }),
    [user, status, adoptSession],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}

/**
 * For the one screen that is reachable without a session: the guest route renders
 * whether or not a provider is above it, and only wants to know whether somebody is
 * signed in so it can say so.
 */
export const useOptionalAuth = () => useContext(AuthContext)
