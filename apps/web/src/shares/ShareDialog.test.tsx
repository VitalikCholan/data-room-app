import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessContextProvider } from '../access/AccessProvider'
import { ShareDialog } from './ShareDialog'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const existingShares = [
  {
    id: 's1',
    nodeId: 'n1',
    mode: 'USER',
    role: 'VIEWER',
    granteeEmail: 'counsel@example.com',
    granteeId: null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  },
]

function renderDialog(role: 'OWNER' | 'VIEWER' = 'OWNER') {
  const onClose = vi.fn()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return {
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <AccessContextProvider value={{ role, scopeRootId: 'root', isOwner: role === 'OWNER' }}>
          <ShareDialog nodeId="n1" nodeName="Legal" nodeType="FOLDER" onClose={onClose} />
        </AccessContextProvider>
      </QueryClientProvider>,
    ),
  }
}

const postCalls = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')

describe('ShareDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('creates a public link and shows it once with a copy button', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? json(
              {
                share: { ...existingShares[0], id: 's2', mode: 'PUBLIC_LINK', granteeEmail: null },
                token: 'tok',
                url: 'https://app.test/s/tok',
              },
              201,
            )
          : json([]),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: /Create link/i }))
    await waitFor(() => expect(screen.getByDisplayValue('https://app.test/s/tok')).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /Copy/i }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://app.test/s/tok')
    // The server keeps only sha256(token): losing this string loses it for good.
    expect(screen.getByText(/shown once/i)).toBeTruthy()
    expect(screen.getByText(/will not see it again/i)).toBeTruthy()
  })

  it('invites a named user by email, including an address with no account yet', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, init?: RequestInit) =>
        Promise.resolve(init?.method === 'POST' ? json({ share: existingShares[0] }, 201) : json([])),
      )
    vi.stubGlobal('fetch', fetchMock)

    renderDialog()
    await userEvent.click(screen.getByRole('tab', { name: /People/i }))
    await userEvent.type(screen.getByLabelText(/Email/i), 'Counsel@Example.com')
    await userEvent.click(screen.getByRole('button', { name: /Invite/i }))

    await waitFor(() => {
      const post = postCalls(fetchMock)[0]
      expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({
        mode: 'USER',
        email: 'counsel@example.com',
      })
    })
    expect(screen.getByText(/do not need an account yet/i)).toBeTruthy()
  })

  it('lists current shares and revokes one, but only after a confirmation', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'DELETE'
          ? json({ ...existingShares[0], revokedAt: new Date().toISOString() })
          : json(existingShares),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderDialog()
    await userEvent.click(screen.getByRole('tab', { name: /People/i }))
    await waitFor(() => expect(screen.getByText('counsel@example.com')).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /Revoke access for counsel@example.com/i }))
    // Revocation is not undoable, so the first click only asks.
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'DELETE')).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: /Confirm revoking access for counsel@example.com/i }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            (init as RequestInit | undefined)?.method === 'DELETE' && String(url).includes('/shares/s1'),
        ),
      ).toBe(true),
    )
  })

  it('sends nothing when the revoke confirmation is dismissed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(existingShares))
    vi.stubGlobal('fetch', fetchMock)

    renderDialog()
    await userEvent.click(screen.getByRole('tab', { name: /People/i }))
    await waitFor(() => expect(screen.getByText('counsel@example.com')).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /Revoke access for counsel@example.com/i }))
    await userEvent.click(screen.getByRole('button', { name: /Keep access for counsel@example.com/i }))

    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'DELETE')).toBe(true)
    expect(screen.getByRole('button', { name: /Revoke access for counsel@example.com/i })).toBeTruthy()
  })

  it('rejects an invalid email before sending', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([]))
    vi.stubGlobal('fetch', fetchMock)
    renderDialog()
    await userEvent.click(screen.getByRole('tab', { name: /People/i }))
    await userEvent.type(screen.getByLabelText(/Email/i), 'not-an-email')
    await userEvent.click(screen.getByRole('button', { name: /Invite/i }))
    expect(screen.getByRole('alert').textContent).toMatch(/valid email/i)
    expect(postCalls(fetchMock)).toHaveLength(0)
  })

  it('reports a rejected share as the sentence the server sent, never as a code', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? json({ code: 'GONE', message: 'This item was deleted by the owner' }, 410)
          : json([]),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: /Create link/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/deleted by the owner/i))
    expect(screen.getByRole('alert').textContent).not.toMatch(/GONE|410/)
  })

  it('states that access is read-only', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([])))
    renderDialog()
    expect(screen.getByText(/read-only/i)).toBeTruthy()
  })

  it('renders nothing at all for a viewer, and asks the server for nothing', () => {
    const fetchMock = vi.fn().mockResolvedValue(json([]))
    vi.stubGlobal('fetch', fetchMock)
    renderDialog('VIEWER')
    expect(screen.queryByRole('button', { name: /Create link/i })).toBeNull()
    expect(screen.queryByRole('tab', { name: /People/i })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
