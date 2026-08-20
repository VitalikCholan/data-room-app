import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomPage } from './RoomPage'
import { queryKeys } from '../api/keys'
import { useUploadStore, type UploadTask } from '../uploads/uploadStore'

// The shell needs a session; this page's own behaviour does not.
vi.mock('../components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

/**
 * At the room root the route carries no node id, so the API is the only thing that knows
 * the folder's real id — and it is deliberately not the null the listing is keyed on.
 */
const ROOT_ID = 'root-uuid'

const listing = (role: 'OWNER' | 'VIEWER') => ({
  items: [
    {
      id: 'd1',
      type: 'FILE',
      name: 'MSA.pdf',
      sizeBytes: 2048,
      updatedAt: new Date().toISOString(),
      currentVersionId: 'v1',
    },
  ],
  nextCursor: null,
  breadcrumbs: [{ id: ROOT_ID, name: 'Project Titan', type: 'FOLDER' }],
  parent: { id: ROOT_ID, name: 'Project Titan', parentId: null },
  role,
  scopeRootId: ROOT_ID,
})

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

function renderRoom(role: 'OWNER' | 'VIEWER') {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(listing(role))))
  vi.stubGlobal('fetch', fetchMock)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    client,
    fetchMock,
    listRequests: () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/nodes?')).length,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/rooms/r1']}>
          <Routes>
            <Route path="/rooms/:roomId" element={<RoomPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  }
}

const uploadedInRoot = (): UploadTask => ({
  id: 'u1',
  batchId: 'b1',
  file: new File([new Uint8Array(8)], 'NDA.pdf', { type: 'application/pdf' }),
  roomId: 'r1',
  parentId: ROOT_ID,
  name: 'NDA.pdf',
  status: 'done',
  progress: 100,
})

describe('RoomPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useUploadStore.setState({ tasks: [], batchChoices: {}, onUploaded: undefined })
  })

  it('refreshes the room-root listing when an upload into it finishes', async () => {
    const { client, listRequests } = renderRoom('OWNER')
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())
    expect(listRequests()).toBe(1)
    // The listing on screen is keyed on a null parent; the finished task names the root
    // node's real id. A per-folder invalidation cannot bridge those two, and the new file
    // would stay invisible for the whole staleTime.
    expect(client.getQueryCache().find({ queryKey: queryKeys.nodes.list('r1', null, 'name') })).toBeTruthy()

    const notify = useUploadStore.getState().onUploaded
    expect(notify).toBeTypeOf('function')
    await act(async () => notify?.(uploadedInRoot()))

    await waitFor(() => expect(listRequests()).toBe(2))
  })
})
