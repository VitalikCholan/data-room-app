import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage'

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'demo@dataroom.app', name: 'Demo' },
    status: 'authenticated',
    logout: vi.fn(),
  }),
}))

const rooms = [
  {
    id: 'r1',
    name: 'Project Titan',
    rootNodeId: 'n1',
    createdAt: new Date().toISOString(),
    rollup: { folders: 4, files: 25, bytes: 5_242_880 },
  },
]

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('DashboardPage', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows a skeleton, then the rooms with their totals', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(json(url.includes('shared-with-me') ? [] : rooms)),
        ),
    )
    renderDashboard()
    await waitFor(() => expect(screen.getByText('Project Titan')).toBeTruthy())
    expect(screen.getByText(/25 files/)).toBeTruthy()
    expect(screen.getByText(/5 MB/)).toBeTruthy()
  })

  it('shows a first-run empty state with a create action', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([])))
    renderDashboard()
    await waitFor(() => expect(screen.getByText(/No Data Rooms yet/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /New Data Room/i })).toBeTruthy()
  })

  it('creates a room and refreshes the list', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('shared-with-me')) return Promise.resolve(json([]))
      if (init?.method === 'POST')
        return Promise.resolve(json({ id: 'r2', name: 'New Room', rootNodeId: 'n2' }, 201))
      return Promise.resolve(json(rooms))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderDashboard()
    await waitFor(() => expect(screen.getByText('Project Titan')).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: /New Data Room/i }))
    await userEvent.type(screen.getByLabelText(/Name/i), 'New Room')
    await userEvent.click(screen.getByRole('button', { name: /^Create$/i }))

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'POST'),
      ).toBe(true),
    )
  })

  it('renders an error state when the list fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ code: 'UNKNOWN', message: 'boom' }, 500)),
    )
    renderDashboard()
    await waitFor(() => expect(screen.getByText(/Something went wrong/i)).toBeTruthy())
  })

  it('lists items shared with the user separately from owned rooms', async () => {
    const shared = [
      {
        shareId: 's1',
        roomId: 'r9',
        roomName: 'Acme',
        nodeId: 'n9',
        nodeName: 'Legal',
        nodeType: 'FOLDER',
        isWholeRoom: false,
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(json(url.includes('shared-with-me') ? shared : [])),
        ),
    )
    renderDashboard()
    await waitFor(() => expect(screen.getByText('Legal')).toBeTruthy())
    expect(screen.getByText(/Shared with me/i)).toBeTruthy()
  })
})
