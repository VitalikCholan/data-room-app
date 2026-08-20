import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchResults } from './SearchResults'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const hits = {
  items: [
    {
      id: 'd1',
      name: 'FY23 Audit.pdf',
      type: 'FILE',
      sizeBytes: 2048,
      updatedAt: new Date().toISOString(),
      parentId: 'fin',
      parentName: 'Financials',
    },
    {
      id: 'fin',
      name: 'Financials',
      type: 'FOLDER',
      sizeBytes: null,
      updatedAt: new Date().toISOString(),
      parentId: 'root',
      parentName: 'Project Titan',
    },
  ],
  nextCursor: null,
}

function renderResults(
  term: string,
  extra: Partial<Parameters<typeof SearchResults>[0]> = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClear = vi.fn()
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SearchResults roomId="r1" term={term} scopeParentId={null} onClear={onClear} {...extra} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, onClear }
}

describe('SearchResults', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows each hit with the folder that contains it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(hits)))
    renderResults('audit')
    await waitFor(() => expect(screen.getByText('FY23 Audit.pdf')).toBeTruthy())
    expect(screen.getByText(/in Financials/i)).toBeTruthy()
  })

  it('links a file to the viewer and a folder into itself', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(hits)))
    renderResults('audit')
    await waitFor(() => expect(screen.getByText('FY23 Audit.pdf')).toBeTruthy())
    expect(screen.getByRole('link', { name: 'FY23 Audit.pdf' }).getAttribute('href')).toBe('/rooms/r1/file/d1')
    expect(screen.getByRole('link', { name: 'Financials' }).getAttribute('href')).toBe('/rooms/r1/f/fin')
  })

  it('shows a specific empty state naming the term', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ items: [], nextCursor: null })))
    renderResults('zzz')
    await waitFor(() => expect(screen.getByText(/No matches for "zzz"/i)).toBeTruthy())
  })

  it('clears the search from the empty state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ items: [], nextCursor: null })))
    const { onClear } = renderResults('zzz')
    await waitFor(() => expect(screen.getByRole('button', { name: /Clear search/i })).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: /Clear search/i }))
    expect(onClear).toHaveBeenCalled()
  })

  it('does not query for a single character', () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ items: [], nextCursor: null }))
    vi.stubGlobal('fetch', fetchMock)
    renderResults('a')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces an error state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ code: 'UNKNOWN', message: 'boom' }, 500)))
    renderResults('audit')
    await waitFor(() => expect(screen.getByText(/Something went wrong/i)).toBeTruthy())
  })

  it('scopes the request to the caller subtree when one is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(hits))
    vi.stubGlobal('fetch', fetchMock)
    renderResults('audit', { scopeParentId: 'legal' })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('parentId=legal')
    expect(url).toContain('q=audit')
  })

  it('navigates in place instead of routing when the caller handles navigation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(hits)))
    const onNavigateFolder = vi.fn()
    const onOpenFile = vi.fn()
    renderResults('audit', { onNavigateFolder, onOpenFile })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Financials' })).toBeTruthy())
    // No url a guest could edit their way up from: both hits are buttons, not links.
    expect(screen.queryByRole('link', { name: 'FY23 Audit.pdf' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Financials' }))
    expect(onNavigateFolder).toHaveBeenCalledWith('fin')
    await userEvent.click(screen.getByRole('button', { name: 'FY23 Audit.pdf' }))
    expect(onOpenFile).toHaveBeenCalledWith({ id: 'd1', name: 'FY23 Audit.pdf' })
  })
})
