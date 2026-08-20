import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MoveDialog } from './MoveDialog'
import type { NodeItem } from '../hooks/useNodeList'

const moving: NodeItem = {
  id: 'legal',
  type: 'FOLDER',
  name: 'Legal',
  sizeBytes: null,
  updatedAt: new Date().toISOString(),
  currentVersionId: null,
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const rootListing = {
  items: [
    {
      id: 'legal',
      type: 'FOLDER',
      name: 'Legal',
      sizeBytes: null,
      updatedAt: new Date().toISOString(),
      currentVersionId: null,
    },
    {
      id: 'fin',
      type: 'FOLDER',
      name: 'Financials',
      sizeBytes: null,
      updatedAt: new Date().toISOString(),
      currentVersionId: null,
    },
    {
      id: 'doc',
      type: 'FILE',
      name: 'a.pdf',
      sizeBytes: 10,
      updatedAt: new Date().toISOString(),
      currentVersionId: 'v',
    },
  ],
  nextCursor: null,
  breadcrumbs: [{ id: 'root', name: 'Room', type: 'FOLDER' }],
  parent: { id: 'root', name: 'Room', parentId: null },
  role: 'OWNER',
  scopeRootId: 'root',
}

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return {
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <MoveDialog roomId="r1" parentId="root" rootFolderId="root" sort="name" node={moving} onClose={onClose} />
      </QueryClientProvider>,
    ),
  }
}

describe('MoveDialog', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists only folders as destinations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(rootListing)))
    renderDialog()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Financials' })).toBeTruthy())
    expect(screen.queryByText('a.pdf')).toBeNull()
  })

  it('disables the folder being moved so its subtree cannot be picked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(rootListing)))
    renderDialog()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Legal' })).toHaveProperty('disabled', true))
    // No expander either: a descendant of the moving node is never a legal destination.
    expect(screen.queryByRole('button', { name: /Expand Legal/i })).toBeNull()
  })

  it('moves to the chosen folder and closes', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, init?: RequestInit) =>
        Promise.resolve(init?.method === 'POST' ? json({ id: 'legal' }, 201) : json(rootListing)),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { onClose } = renderDialog()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Financials' })).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: 'Financials' }))
    await userEvent.click(screen.getByRole('button', { name: /^Move here$/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const moveCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')
    expect(moveCall?.[0]).toBe('/api/nodes/legal/move')
    expect(JSON.parse((moveCall?.[1] as RequestInit).body as string)).toEqual({ targetParentId: 'fin' })
  })

  it('shows the 409 name-conflict message instead of a raw code', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? json({ code: 'NAME_CONFLICT', message: '"Legal" already exists in the destination folder' }, 409)
          : json(rootListing),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { onClose } = renderDialog()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Financials' })).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: 'Financials' }))
    await userEvent.click(screen.getByRole('button', { name: /^Move here$/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already exists/i))
    expect(screen.getByRole('alert').textContent).not.toMatch(/NAME_CONFLICT/)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('reads a move cycle as a sentence, not a code', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? json({ code: 'MOVE_CYCLE', message: 'A folder cannot be moved into its own subfolder' }, 409)
          : json(rootListing),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderDialog()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Financials' })).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: 'Financials' }))
    await userEvent.click(screen.getByRole('button', { name: /^Move here$/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/own subfolder/i))
  })
})
