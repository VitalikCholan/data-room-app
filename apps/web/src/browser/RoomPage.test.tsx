import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

const searchHits = {
  items: [
    {
      id: 'd2',
      name: 'FY23 Audit.pdf',
      type: 'FILE',
      sizeBytes: 4096,
      updatedAt: new Date().toISOString(),
      parentId: 'fin',
      parentName: 'Financials',
    },
  ],
  nextCursor: null,
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const fileDrag = { dataTransfer: { types: ['Files'], files: [], getData: () => '' } }

function renderRoom(role: 'OWNER' | 'VIEWER') {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const path = String(url)
    if (path.includes('/search?')) return Promise.resolve(json(searchHits))
    if (path.includes('/shares')) return Promise.resolve(json([]))
    return Promise.resolve(json(listing(role)))
  })
  vi.stubGlobal('fetch', fetchMock)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    client,
    fetchMock,
    listRequests: () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/nodes?')).length,
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
  nodeId: 'd1',
  versionId: 'v2',
})

describe('RoomPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useUploadStore.setState({ tasks: [], batchChoices: {}, onUploaded: undefined })
  })

  it('gives an owner both ways to upload: the drop target and the file input', async () => {
    const { container } = renderRoom('OWNER')
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())

    expect(container.querySelector('input[type="file"]')).toBeTruthy()
    fireEvent.dragEnter(screen.getByText('MSA.pdf'), fileDrag)
    expect(screen.getByText(/Drop PDFs here/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Upload/i })).toBeTruthy()
  })

  it('gives a viewer neither: no drop target, and no file input in the DOM at all', async () => {
    const { container } = renderRoom('VIEWER')
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())

    expect(container.querySelector('input[type="file"]')).toBeNull()
    fireEvent.dragEnter(screen.getByText('MSA.pdf'), fileDrag)
    expect(screen.queryByText(/Drop PDFs here/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Upload/i })).toBeNull()
  })

  it('shares the folder on screen from the toolbar, naming the room when it is the root', async () => {
    renderRoom('OWNER')
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /^Share$/i }))
    // The route carried no node id, so the shared folder is the room root itself.
    await waitFor(() => expect(screen.getByText(/Share this Data Room/i)).toBeTruthy())
  })

  it('shares a single row from its own menu', async () => {
    renderRoom('OWNER')
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /Actions for MSA.pdf/i }))
    await userEvent.click(screen.getByText('Share…'))
    await waitFor(() => expect(screen.getByText(/Share file "MSA.pdf"/i)).toBeTruthy())
  })

  it('replaces the listing with results while a search is running, and puts it back on clear', async () => {
    const { fetchMock } = renderRoom('OWNER')
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())

    await userEvent.type(screen.getByLabelText(/Search by name/i), 'aud')
    await waitFor(() => expect(screen.getByText('FY23 Audit.pdf')).toBeTruthy())
    // The table is gone, not merely covered: a hit list is a different answer.
    expect(screen.queryByText('MSA.pdf')).toBeNull()
    expect(screen.getByText(/in Financials/i)).toBeTruthy()
    // The owner names no parent, so the API resolves access from the room and the whole
    // tree answers.
    const searched = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/search?'))
    expect(searched).toHaveLength(1)
    expect(searched[0]).not.toContain('parentId')

    await userEvent.click(screen.getByRole('button', { name: /Clear search/i }))
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())
  })

  it('asks nothing until the term is worth asking about', async () => {
    const { fetchMock } = renderRoom('OWNER')
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())

    await userEvent.type(screen.getByLabelText(/Search by name/i), 'a')
    // Two characters is the server's minimum: one would only earn a 422. The folder
    // listing stays on screen rather than being traded for a placeholder.
    await waitFor(() => expect(screen.getByDisplayValue('a')).toBeTruthy())
    expect(screen.getByText('MSA.pdf')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/search?'))).toBe(false)
  })

  it('leaves search to a viewer, who may read but not change anything', async () => {
    renderRoom('VIEWER')
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())
    expect(screen.getByLabelText(/Search by name/i)).toBeTruthy()
  })

  it('refreshes the room-root listing when an upload into it finishes', async () => {
    const { client, listRequests } = renderRoom('OWNER')
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())
    expect(listRequests()).toBe(1)
    // The listing on screen is keyed on a null parent; the finished task names the root
    // node's real id. A per-folder invalidation cannot bridge those two, and the new file
    // would stay invisible for the whole staleTime.
    expect(
      client.getQueryCache().find({ queryKey: queryKeys.nodes.list('r1', null, 'name') }),
    ).toBeTruthy()

    const notify = useUploadStore.getState().onUploaded
    expect(notify).toBeTypeOf('function')
    await act(async () => notify?.(uploadedInRoot()))

    await waitFor(() => expect(listRequests()).toBe(2))
  })

  it('drops the cached bytes and history of a file that just gained a version', async () => {
    const { client } = renderRoom('OWNER')
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())

    // A viewer visited earlier in the session left the current bytes cached for four
    // minutes; an upload with onConflict NEW_VERSION has just made them the wrong ones.
    client.setQueryData(queryKeys.nodes.content('d1'), new Blob(['old']))
    client.setQueryData(queryKeys.nodes.versions('d1'), [])

    const notify = useUploadStore.getState().onUploaded
    await act(async () => notify?.(uploadedInRoot()))

    await waitFor(() => {
      expect(client.getQueryState(queryKeys.nodes.content('d1'))?.isInvalidated).toBe(true)
      expect(client.getQueryState(queryKeys.nodes.versions('d1'))?.isInvalidated).toBe(true)
    })
  })
})
