import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileViewerPage } from './FileViewerPage'

vi.mock('../components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const createObjectURL = vi.fn(() => 'blob:pdf')
const revokeObjectURL = vi.fn()

const pdfResponse = () =>
  new Response(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), {
    status: 200,
    headers: { 'Content-Type': 'application/pdf' },
  })

const errorResponse = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ code, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const now = new Date().toISOString()

const versions = [
  {
    id: 'v2',
    versionNo: 2,
    sizeBytes: 4096,
    mimeType: 'application/pdf',
    createdAt: now,
    isCurrent: true,
  },
  {
    id: 'v1',
    versionNo: 1,
    sizeBytes: 2048,
    mimeType: 'application/pdf',
    createdAt: now,
    isCurrent: false,
  },
]

const ownedRoom = {
  id: 'r1',
  name: 'Project Titan',
  rootNodeId: 'root',
  createdAt: now,
  rollup: { folders: 0, files: 1, bytes: 4096 },
}

/**
 * One mock for the three answers the viewer needs: the bytes, the history, and whether
 * this caller owns the room — which is what decides if restore is theirs to press.
 */
const viewerFetch = (options: { owned?: boolean; content?: () => Response } = {}) =>
  vi.fn().mockImplementation((url: string) => {
    const path = String(url)
    if (path.endsWith('/versions')) return Promise.resolve(json(versions))
    if (path.endsWith('/rooms'))
      return Promise.resolve(json(options.owned === false ? [] : [ownedRoom]))
    return Promise.resolve((options.content ?? pdfResponse)())
  })

const contentUrls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/content'))

function renderViewer(state?: { name: string }, search?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/rooms/r1/file/d1', search, state }]}>
        <Routes>
          <Route path="/rooms/:roomId/file/:nodeId" element={<FileViewerPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('FileViewerPage', () => {
  beforeEach(() => {
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
  })
  afterEach(() => vi.restoreAllMocks())

  it('renders the document from the content endpoint', async () => {
    const fetchMock = viewerFetch()
    vi.stubGlobal('fetch', fetchMock)
    renderViewer({ name: 'MSA.pdf' })

    await waitFor(() => expect(screen.getByTitle('MSA.pdf')).toHaveProperty('src', 'blob:pdf'))
    // No version parameter for the current version: that is the url the endpoint answers
    // without being asked.
    expect(contentUrls(fetchMock)).toEqual(['/api/nodes/d1/content'])
    expect(screen.getByRole('heading', { name: 'MSA.pdf' })).toBeTruthy()
  })

  it('says the content is gone when the stored object was withdrawn', async () => {
    vi.stubGlobal(
      'fetch',
      viewerFetch({
        content: () => errorResponse(410, 'GONE', 'File content is no longer available'),
      }),
    )
    renderViewer({ name: 'MSA.pdf' })

    await waitFor(() => expect(screen.getByText('No longer available')).toBeTruthy())
    expect(screen.getByText('File content is no longer available')).toBeTruthy()
    expect(screen.queryByTitle('MSA.pdf')).toBeNull()
    expect(screen.getByRole('link', { name: /Back to the Data Room/i }).getAttribute('href')).toBe(
      '/rooms/r1',
    )
  })

  it('reports no access as not found, never as forbidden', async () => {
    vi.stubGlobal(
      'fetch',
      viewerFetch({
        content: () => errorResponse(404, 'NOT_FOUND', 'Not found or you do not have access'),
      }),
    )
    renderViewer()

    await waitFor(() => expect(screen.getByText(/Not found/i)).toBeTruthy())
  })

  it('falls back to a neutral title when it was opened by url', async () => {
    vi.stubGlobal('fetch', viewerFetch())
    renderViewer()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Document' })).toBeTruthy())
  })

  it('shows the history beside the document, with the current version marked', async () => {
    vi.stubGlobal('fetch', viewerFetch())
    renderViewer({ name: 'MSA.pdf' })

    await waitFor(() => expect(screen.getByText(/Version 2/)).toBeTruthy())
    expect(screen.getByText(/Version 1/)).toBeTruthy()
    expect(screen.getByText(/Current/i)).toBeTruthy()
  })

  it('reads an older version when one is picked, and says so in the url', async () => {
    const fetchMock = viewerFetch()
    vi.stubGlobal('fetch', fetchMock)
    renderViewer({ name: 'MSA.pdf' })
    await waitFor(() => expect(screen.getByRole('button', { name: /Version 1/ })).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /Version 1/ }))
    await waitFor(() =>
      expect(contentUrls(fetchMock)).toContain('/api/nodes/d1/content?version=v1'),
    )
    // In the url, so the reader can go back to the current version with the back button
    // and hand somebody the exact version they are looking at.
    expect(screen.getByText(/viewing/i)).toBeTruthy()
  })

  it('opens straight into the version named in the url', async () => {
    const fetchMock = viewerFetch()
    vi.stubGlobal('fetch', fetchMock)
    renderViewer({ name: 'MSA.pdf' }, '?version=v1')

    await waitFor(() => expect(screen.getByTitle('MSA.pdf')).toBeTruthy())
    expect(contentUrls(fetchMock)).toEqual(['/api/nodes/d1/content?version=v1'])
  })

  it('offers restore to the owner of the room', async () => {
    vi.stubGlobal('fetch', viewerFetch())
    renderViewer({ name: 'MSA.pdf' })
    await waitFor(() => expect(screen.getByRole('button', { name: /^Restore$/i })).toBeTruthy())
  })

  it('renders no restore control at all for someone the file was only shared with', async () => {
    // The room is not among the caller's own, so they are a viewer here — the listing
    // that carries a role never runs on this page.
    vi.stubGlobal('fetch', viewerFetch({ owned: false }))
    renderViewer({ name: 'MSA.pdf' })

    await waitFor(() => expect(screen.getByText(/Version 1/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Restore$/i })).toBeNull()
    // Reading an older version is still theirs.
    expect(screen.getByRole('button', { name: /Version 1/ })).toBeTruthy()
  })

  it('releases the object url when the viewer closes', async () => {
    vi.stubGlobal('fetch', viewerFetch())
    const { unmount } = renderViewer({ name: 'MSA.pdf' })
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pdf')
  })
})
