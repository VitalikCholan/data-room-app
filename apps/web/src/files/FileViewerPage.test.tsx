import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
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

function renderViewer(state?: { name: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/rooms/r1/file/d1', state }]}>
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
    const fetchMock = vi.fn().mockResolvedValue(pdfResponse())
    vi.stubGlobal('fetch', fetchMock)
    renderViewer({ name: 'MSA.pdf' })

    await waitFor(() => expect(screen.getByTitle('MSA.pdf')).toHaveProperty('src', 'blob:pdf'))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/nodes/d1/content')
    expect(screen.getByRole('heading', { name: 'MSA.pdf' })).toBeTruthy()
  })

  it('says the content is gone when the stored object was withdrawn', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errorResponse(410, 'GONE', 'File content is no longer available')),
    )
    renderViewer({ name: 'MSA.pdf' })

    await waitFor(() => expect(screen.getByText('No longer available')).toBeTruthy())
    expect(screen.getByText('File content is no longer available')).toBeTruthy()
    expect(screen.queryByTitle('MSA.pdf')).toBeNull()
    expect(screen.getByRole('link', { name: /Back to the Data Room/i }).getAttribute('href')).toBe('/rooms/r1')
  })

  it('reports no access as not found, never as forbidden', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errorResponse(404, 'NOT_FOUND', 'Not found or you do not have access')),
    )
    renderViewer()

    await waitFor(() => expect(screen.getByText(/Not found/i)).toBeTruthy())
  })

  it('falls back to a neutral title when it was opened by url', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pdfResponse()))
    renderViewer()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Document' })).toBeTruthy())
  })

  it('releases the object url when the viewer closes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pdfResponse()))
    const { unmount } = renderViewer({ name: 'MSA.pdf' })
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pdf')
  })
})
