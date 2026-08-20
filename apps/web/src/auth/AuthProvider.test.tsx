import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './AuthProvider'
import { getAccessToken, setAccessToken } from '../api/client'

function Probe() {
  const { user, status, login, logout } = useAuth()
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.email ?? 'none'}</span>
      <button onClick={() => void login({ email: 'a@b.io', password: 'password123' })}>
        login
      </button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  )
}

function renderProbe() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('AuthProvider', () => {
  beforeEach(() => {
    setAccessToken(null)
    vi.restoreAllMocks()
  })

  it('starts anonymous when the refresh cookie is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ code: 'INVALID_CREDENTIALS' }, 401)))
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'))
  })

  it('restores the session from the refresh cookie on first load', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          json(
            { accessToken: 'tok', user: { id: 'u1', email: 'restored@acme.io', name: 'R' } },
            201,
          ),
        ),
    )
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('restored@acme.io'))
    expect(getAccessToken()).toBe('tok')
  })

  it('stores the token and user after a successful login', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ code: 'INVALID_CREDENTIALS' }, 401))
      .mockResolvedValueOnce(
        json({ accessToken: 'tok-2', user: { id: 'u2', email: 'a@b.io', name: 'A' } }, 201),
      )
    vi.stubGlobal('fetch', fetchMock)

    renderProbe()
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'))
    await userEvent.click(screen.getByText('login'))
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('a@b.io'))
  })

  it('clears the session on logout', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ accessToken: 'tok', user: { id: 'u1', email: 'x@y.io', name: 'X' } }, 201),
      )
      .mockResolvedValueOnce(json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    renderProbe()
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('x@y.io'))
    await userEvent.click(screen.getByText('logout'))
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('none'))
    expect(getAccessToken()).toBeNull()
  })
})
