import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessContextProvider } from '../access/AccessProvider'
import { VersionHistoryDrawer } from './VersionHistoryDrawer'

const now = new Date().toISOString()

const versions = [
  { id: 'v3', versionNo: 3, sizeBytes: 4096, mimeType: 'application/pdf', createdAt: now, isCurrent: true },
  { id: 'v2', versionNo: 2, sizeBytes: 2048, mimeType: 'application/pdf', createdAt: now, isCurrent: false },
  { id: 'v1', versionNo: 1, sizeBytes: 1024, mimeType: 'application/pdf', createdAt: now, isCurrent: false },
]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function renderDrawer(role: 'OWNER' | 'VIEWER', selectedVersionId: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const onSelectVersion = vi.fn()
  const view = render(
    <QueryClientProvider client={client}>
      <AccessContextProvider value={{ role, scopeRootId: 'root', isOwner: role === 'OWNER' }}>
        <VersionHistoryDrawer
          nodeId="d1"
          roomId="r1"
          selectedVersionId={selectedVersionId}
          onSelectVersion={onSelectVersion}
        />
      </AccessContextProvider>
    </QueryClientProvider>,
  )
  return { ...view, client, onSelectVersion }
}

describe('VersionHistoryDrawer', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists versions newest first and marks the current one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(versions)))
    const { container } = renderDrawer('OWNER')
    await waitFor(() => expect(screen.getByText(/Version 3/)).toBeTruthy())

    const text = container.textContent ?? ''
    expect(text.indexOf('Version 3')).toBeLessThan(text.indexOf('Version 1'))
    expect(screen.getByText(/Current/i)).toBeTruthy()
  })

  it('offers restore to an owner for older versions only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(versions)))
    renderDrawer('OWNER')
    // Two older versions, and nothing to restore on the one already current.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Restore/i })).toHaveLength(2))
  })

  it('hides restore from a viewer, who may read every version but change none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(versions)))
    renderDrawer('VIEWER')
    await waitFor(() => expect(screen.getByText(/Version 2/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Restore/i })).toBeNull()
    // Viewing an older version is a read, so a viewer keeps it.
    expect(screen.getByRole('button', { name: /Version 2/ })).toBeTruthy()
  })

  it('asks before restoring, and does nothing if the question is dismissed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(versions))
    vi.stubGlobal('fetch', fetchMock)
    renderDrawer('OWNER')
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Restore/i })).toHaveLength(2))

    await userEvent.click(screen.getAllByRole('button', { name: /^Restore/i })[0])
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    // Restoring rewrites which bytes the file serves, so it is never one stray click away.
    await userEvent.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/restore'))).toBe(false)
  })

  it('restores a confirmed version and refreshes the history', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, init?: RequestInit) =>
        Promise.resolve(init?.method === 'POST' ? json({ id: 'd1' }, 201) : json(versions)),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { onSelectVersion } = renderDrawer('OWNER')
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Restore/i })).toHaveLength(2))

    await userEvent.click(screen.getAllByRole('button', { name: /^Restore/i })[0])
    await userEvent.click(screen.getByRole('button', { name: /Restore version 2/i }))

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/nodes/d1/versions/v2/restore'))).toBe(true),
    )
    // The history is now a version longer, and the viewer goes back to what is current.
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/nodes/d1/versions')).length).toBeGreaterThan(
        1,
      ),
    )
    expect(onSelectVersion).toHaveBeenCalledWith(null)
  })

  it('says so when there is only one version', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([versions[0]])))
    renderDrawer('OWNER')
    await waitFor(() => expect(screen.getByText(/only version/i)).toBeTruthy())
  })

  it('reports the version a reader picked, and null for the current one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(versions)))
    const { onSelectVersion } = renderDrawer('OWNER')
    await waitFor(() => expect(screen.getByRole('button', { name: /Version 2/ })).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /Version 2/ }))
    expect(onSelectVersion).toHaveBeenCalledWith('v2')
    await userEvent.click(screen.getByRole('button', { name: /Version 3/ }))
    // Not the id: the current version is what the plain content url already serves.
    expect(onSelectVersion).toHaveBeenCalledWith(null)
  })

  it('surfaces a failed history rather than an empty panel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ code: 'UNKNOWN', message: 'boom' }, 500)))
    renderDrawer('OWNER')
    await waitFor(() => expect(screen.getByText(/Something went wrong/i)).toBeTruthy())
  })
})
