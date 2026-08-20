import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { DeleteDialog } from './DeleteDialog'
import type { NodeItem } from '../hooks/useNodeList'

const folder: NodeItem = {
  id: 'f1',
  type: 'FOLDER',
  name: 'Legal',
  sizeBytes: null,
  updatedAt: new Date().toISOString(),
  currentVersionId: null,
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function renderDialog(node: NodeItem, onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return {
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <DeleteDialog roomId="r1" parentId="root" sort="name" node={node} onClose={onClose} />
      </QueryClientProvider>,
    ),
  }
}

describe('DeleteDialog', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('states exactly what will be destroyed, including shares', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ folders: 2, files: 7, bytes: 3_145_728, activeShares: 3 })))
    renderDialog(folder)
    await waitFor(() => expect(screen.getByText(/7 files/)).toBeTruthy())
    expect(screen.getByText(/2 folders/)).toBeTruthy()
    expect(screen.getByText(/3 MB/)).toBeTruthy()
    expect(screen.getByText(/3 people lose access/i)).toBeTruthy()
  })

  it('omits the share warning when nothing is shared', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ folders: 0, files: 1, bytes: 1024, activeShares: 0 })))
    renderDialog(folder)
    await waitFor(() => expect(screen.getByText(/1 file/)).toBeTruthy())
    expect(screen.queryByText(/lose access/i)).toBeNull()
  })

  it('keeps the confirm button disabled until the preview has loaded', async () => {
    let resolvePreview: (value: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => new Promise<Response>((resolve) => (resolvePreview = resolve))),
    )
    renderDialog(folder)
    expect(screen.getByRole('button', { name: /Delete/i })).toHaveProperty('disabled', true)
    resolvePreview(json({ folders: 0, files: 0, bytes: 0, activeShares: 0 }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Delete/i })).toHaveProperty('disabled', false))
  })

  it('deletes and closes on confirm', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'DELETE'
          ? json({ id: 'f1', deletedNodes: 3 })
          : json({ folders: 1, files: 2, bytes: 2048, activeShares: 0 }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { onClose } = renderDialog(folder)
    await waitFor(() => expect(screen.getByRole('button', { name: /Delete/i })).toHaveProperty('disabled', false))
    await userEvent.click(screen.getByRole('button', { name: /Delete/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'DELETE')).toBe(true)
  })
})
