import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../auth/AuthProvider'
import { api, getShareToken, setAccessToken, setShareToken } from '../api/client'
import { GuestPage } from './GuestPage'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const bootstrap = {
  role: 'VIEWER',
  roomId: 'r1',
  roomName: 'Project Titan',
  node: { id: 'legal', name: 'Legal', type: 'FOLDER' },
}

const now = new Date().toISOString()
const legalCrumb = { id: 'legal', name: 'Legal', type: 'FOLDER' }
const dealsCrumb = { id: 'deals', name: 'Deals', type: 'FOLDER' }

const listing = {
  items: [
    {
      id: 'd1',
      type: 'FILE',
      name: 'MSA.pdf',
      sizeBytes: 2048,
      updatedAt: now,
      currentVersionId: 'v1',
    },
  ],
  nextCursor: null,
  breadcrumbs: [legalCrumb],
  parent: { id: 'legal', name: 'Legal', parentId: null },
  role: 'VIEWER',
  scopeRootId: 'legal',
}

/** The shared folder holds a subfolder, so the guest has somewhere to go — and back. */
const nestedListings: Record<string, unknown> = {
  legal: {
    ...listing,
    items: [
      {
        id: 'deals',
        type: 'FOLDER',
        name: 'Deals',
        sizeBytes: null,
        updatedAt: now,
        currentVersionId: null,
      },
    ],
  },
  deals: {
    ...listing,
    breadcrumbs: [legalCrumb, dealsCrumb],
    parent: { id: 'deals', name: 'Deals', parentId: 'legal' },
  },
}

const searchHits = {
  items: [
    {
      id: 'd7',
      name: 'NDA.pdf',
      type: 'FILE',
      sizeBytes: 1024,
      updatedAt: now,
      parentId: 'deals',
      parentName: 'Deals',
    },
  ],
  nextCursor: null,
}

const guestRoutes = (
  <MemoryRouter initialEntries={['/s/tok']}>
    <Routes>
      <Route path="/s/:token" element={<GuestPage />} />
    </Routes>
  </MemoryRouter>
)

function renderGuest() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{guestRoutes}</QueryClientProvider>)
}

/** The same route, but mounted inside the session provider the real app wraps it in. */
function renderGuestSignedIn() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/s/tok']}>
        <AuthProvider>
          <Routes>
            <Route path="/s/:token" element={<GuestPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const headersOf = (call: unknown[]) => (call[1] as RequestInit).headers as Record<string, string>
const listCalls = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls.filter(([url]) => String(url).includes('/nodes?'))

describe('GuestPage', () => {
  beforeEach(() => {
    setShareToken(null)
    setAccessToken(null)
    vi.restoreAllMocks()
  })
  afterEach(() => {
    setShareToken(null)
    setAccessToken(null)
  })

  it('resolves the token, then lists the shared folder read-only', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(json(url.includes('/shared/') ? bootstrap : listing)),
        ),
    )
    const { container } = renderGuest()
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())
    expect(screen.getByText(/Shared with you/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /New folder/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Upload/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Share$/i })).toBeNull()
    // No way out of the shared subtree: not one link into the authenticated app.
    expect(container.querySelectorAll('a[href^="/rooms/"]')).toHaveLength(0)
  })

  it('sends the share token, and only the share token, on the listing request', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(json(url.includes('/shared/') ? bootstrap : listing)),
      )
    vi.stubGlobal('fetch', fetchMock)
    renderGuest()
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())

    const headers = headersOf(listCalls(fetchMock)[0])
    expect(headers['X-Share-Token']).toBe('tok')
    expect(headers.Authorization).toBeUndefined()
  })

  it('keeps a guest inside the share when they walk down and back up', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/shared/')) return Promise.resolve(json(bootstrap))
      const parentId = new URL(url, 'http://test').searchParams.get('parentId') ?? 'legal'
      return Promise.resolve(json(nestedListings[parentId]))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderGuest()

    await userEvent.click(await screen.findByRole('button', { name: 'Deals' }))
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())

    // The crumb above is a control, not a link: a link would point at a route behind
    // RequireAuth and bounce the guest to the sign-in page.
    expect(screen.queryByRole('link', { name: 'Legal' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Legal' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deals' })).toBeTruthy())
  })

  it('searches inside the share only, and opens a hit in place', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:pdf', revokeObjectURL: () => undefined })
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/shared/')) return Promise.resolve(json(bootstrap))
      if (url.includes('/search?')) return Promise.resolve(json(searchHits))
      return Promise.resolve(json(listing))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = renderGuest()
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())

    await userEvent.type(screen.getByLabelText(/Search by name/i), 'nda')
    await waitFor(() => expect(screen.getByRole('button', { name: 'NDA.pdf' })).toBeTruthy())

    // Pinned to the shared node: without this the API would resolve access from the room
    // and a guest could name a file they were never given.
    const searched = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/search?'))
    expect(searched).toHaveLength(1)
    expect(new URL(searched[0], 'http://test').searchParams.get('parentId')).toBe('legal')
    // Still no url out of the share: the hit is a control, not a link.
    expect(container.querySelectorAll('a[href^="/rooms/"]')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'NDA.pdf' }))
    await waitFor(() => expect(screen.getByTitle('NDA.pdf')).toBeTruthy())
  })

  it('shows the revoked message on 410 rather than a bare not-found', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(json({ code: 'GONE', message: 'This link is no longer active' }, 410)),
    )
    renderGuest()
    await waitFor(() => expect(screen.getByText(/no longer active/i)).toBeTruthy())
  })

  it('shows a not-found message for a token that never existed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ code: 'NOT_FOUND', message: 'Not found' }, 404)),
    )
    renderGuest()
    await waitFor(() => expect(screen.getByText(/link is not valid/i)).toBeTruthy())
  })

  it('shows the owner-deleted message when the item disappears mid-session', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('/shared/')
            ? json(bootstrap)
            : json({ code: 'GONE', message: 'This item was deleted by the owner' }, 410),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    renderGuest()
    await waitFor(() => expect(screen.getByText(/deleted by the owner/i)).toBeTruthy())

    // Terminal, not a retry loop: one listing attempt, and nothing to press.
    expect(listCalls(fetchMock)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /Try again/i })).toBeNull()
  })

  it('renders a shared file itself, without ever asking for a folder listing', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:pdf', revokeObjectURL: () => undefined })
    const fileBootstrap = { ...bootstrap, node: { id: 'd1', name: 'MSA.pdf', type: 'FILE' } }
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/shared/')
          ? json(fileBootstrap)
          : new Response(new Blob(['%PDF-1.7']), {
              status: 200,
              headers: { 'Content-Type': 'application/pdf' },
            }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderGuest()
    await waitFor(() => expect(screen.getByTitle('MSA.pdf')).toHaveProperty('src', 'blob:pdf'))
    // A file is not a folder: listing it would 404 and read as a broken link.
    expect(listCalls(fetchMock)).toHaveLength(0)
  })

  it('clears the share token when the guest view is left', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(json(url.includes('/shared/') ? bootstrap : listing)),
        ),
    )
    const { unmount } = renderGuest()
    await waitFor(() => expect(getShareToken()).toBe('tok'))
    unmount()
    expect(getShareToken()).toBeNull()
  })

  it('takes the guest search results with it when the share view is left', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/shared/')) return Promise.resolve(json(bootstrap))
      if (url.includes('/search?')) return Promise.resolve(json(searchHits))
      return Promise.resolve(json(listing))
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { unmount } = render(
      <QueryClientProvider client={client}>{guestRoutes}</QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())
    await userEvent.type(screen.getByLabelText(/Search by name/i), 'nda')
    await waitFor(() =>
      expect(client.getQueryCache().findAll({ queryKey: ['search'] })).toHaveLength(1),
    )

    unmount()
    // Not stale — somebody else's. An owner who opened their own link must not inherit
    // the scoped answers the recipient got.
    expect(client.getQueryCache().findAll({ queryKey: ['search'] })).toHaveLength(0)
  })

  it('hands a signed-in visitor their own identity back when they leave the share', async () => {
    // The debt this closes: the client gives the share token precedence over the bearer,
    // so without the clearing above an owner who opened a share link stayed a guest for
    // every request they made afterwards.
    setAccessToken('owner-bearer')
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(json(url.includes('/shared/') ? bootstrap : listing)),
      )
    vi.stubGlobal('fetch', fetchMock)

    const { unmount } = renderGuest()
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())
    expect(headersOf(listCalls(fetchMock)[0]).Authorization).toBeUndefined()

    unmount()
    await api.get('/rooms')
    const after = headersOf(fetchMock.mock.calls[fetchMock.mock.calls.length - 1])
    expect(after.Authorization).toBe('Bearer owner-bearer')
    expect(after['X-Share-Token']).toBeUndefined()
  })

  it('tells a signed-in visitor they are seeing the recipient view, and offers the way out', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/auth/refresh'))
        return Promise.resolve(
          json({
            accessToken: 'owner-bearer',
            user: { id: 'u1', email: 'owner@acme.io', name: 'O' },
          }),
        )
      return Promise.resolve(json(url.includes('/shared/') ? bootstrap : listing))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderGuestSignedIn()
    await waitFor(() => expect(screen.getByText(/owner@acme.io/i)).toBeTruthy())
    expect(screen.getByText(/what the recipient sees/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Leave the shared view/i }).getAttribute('href')).toBe(
      '/',
    )

    // Signing the session back in must not steal the share token from the route that owns it.
    await waitFor(() => expect(listCalls(fetchMock).length).toBeGreaterThan(0))
    expect(headersOf(listCalls(fetchMock)[0])['X-Share-Token']).toBe('tok')
    expect(getShareToken()).toBe('tok')
  })
})
