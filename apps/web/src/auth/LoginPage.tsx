import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { useAuth } from './AuthProvider'

const googleEnabled = import.meta.env.VITE_GOOGLE_ENABLED === 'true'

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login({ email, password })
      navigate(params.get('returnTo') ?? '/', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-xl font-semibold">Sign in to Data Room</h1>
        <p className="mt-1 text-sm text-subtle">Secure document sharing for due diligence.</p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="text-sm font-medium" htmlFor="email">
          Email
        </label>
        <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />

        <label className="text-sm font-medium" htmlFor="password">
          Password
        </label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {googleEnabled ? (
        <a
          href="/api/auth/google"
          className="flex h-9 items-center justify-center rounded-md border border-border bg-surface text-sm font-medium hover:bg-muted"
        >
          Continue with Google
        </a>
      ) : null}

      <p className="text-sm text-subtle">
        No account?{' '}
        <Link className="text-accent hover:underline" to="/register">
          Create one
        </Link>
      </p>
    </main>
  )
}
