import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RenameDialog } from './RenameDialog'
import type { NodeItem } from '../hooks/useNodeList'

const file: NodeItem = {
  id: 'd1',
  type: 'FILE',
  name: 'MSA.pdf',
  sizeBytes: 1024,
  updatedAt: new Date().toISOString(),
  currentVersionId: 'v1',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return {
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <RenameDialog roomId="r1" parentId="root" sort="name" node={file} onClose={onClose} />
      </QueryClientProvider>,
    ),
  }
}

describe('RenameDialog', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('pre-fills the current name and selects the stem, not the extension', () => {
    renderDialog()
    const input = screen.getByLabelText(/Name/i, { selector: 'input' }) as HTMLInputElement
    expect(input.value).toBe('MSA.pdf')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('MSA'.length)
  })

  it('rejects a slash before sending anything', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderDialog()
    const input = screen.getByLabelText(/Name/i, { selector: 'input' })
    await userEvent.clear(input)
    await userEvent.type(input, 'a/b.pdf')
    await userEvent.click(screen.getByRole('button', { name: /Save/i }))
    expect(screen.getByRole('alert').textContent).toMatch(/cannot contain/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a 409 inline instead of closing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          json({ code: 'NAME_CONFLICT', message: 'That name is taken in this folder' }, 409),
        ),
    )
    const { onClose } = renderDialog()
    const input = screen.getByLabelText(/Name/i, { selector: 'input' })
    await userEvent.clear(input)
    await userEvent.type(input, 'NDA.pdf')
    await userEvent.click(screen.getByRole('button', { name: /Save/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/taken/i))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes after a successful rename', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ id: 'd1', name: 'NDA.pdf' })))
    const { onClose } = renderDialog()
    const input = screen.getByLabelText(/Name/i, { selector: 'input' })
    await userEvent.clear(input)
    await userEvent.type(input, 'NDA.pdf')
    await userEvent.click(screen.getByRole('button', { name: /Save/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
