/* eslint-disable react-refresh/only-export-components -- useAuth is the companion hook of this provider */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, onUnauthenticated, setAccessToken, setShareToken } from '../api/client'

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

  const adoptSession = useCallback((session: SessionResponse) => {
    setAccessToken(session.accessToken)
    setShareToken(null)
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
