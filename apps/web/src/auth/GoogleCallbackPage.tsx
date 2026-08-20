import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { useAuth } from './AuthProvider'
import type { SessionUser } from './AuthProvider'

/**
 * The API redirects here with the access token in the URL fragment. The fragment is
 * consumed and immediately replaced so the token never lands in history or a referrer.
 */
export function GoogleCallbackPage() {
  const { adoptSession } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('access_token')
    if (!token) {
      navigate('/login', { replace: true })
      return
    }
    window.history.replaceState(null, '', '/auth/callback')
    // The token alone is enough to fetch the profile; refresh already lives in a cookie.
    adoptSession({ accessToken: token, user: { id: '', email: '', name: '' } })
    // The contract's GET /auth/me returns a `{ user }` envelope, matching login/refresh.
    void api
      .get<{ user: SessionUser }>('/auth/me')
      .then(({ user }) => adoptSession({ accessToken: token, user }))
      .finally(() => navigate('/', { replace: true }))
  }, [adoptSession, navigate])

  return <p className="p-8 text-sm text-subtle">Finishing sign-in…</p>
}
