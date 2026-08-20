import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateFolderDialog } from './CreateFolderDialog'
import { queryKeys } from '../../api/keys'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** What the API calls the room root. The listing showing it is keyed on a null parent. */
const ROOT_ID = 'root-uuid'

const rootListingKey = queryKeys.nodes.list('r1', null, 'name')

function renderDialog(parentId = ROOT_ID) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  client.setQueryData(rootListingKey, { pages: [{ items: [] }], pageParams: [null] })
  const onClose = vi.fn()
  return {
    client,
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <CreateFolderDialog roomId="r1" parentId={parentId} open onClose={onClose} />
      </QueryClientProvider>,
    ),
  }
}

async function submit(name: string) {
  const input = screen.getByLabelText(/Name/i, { selector: 'input' })
  await userEvent.type(input, name)
  await userEvent.click(screen.getByRole('button', { name: /Create folder/i }))
}

describe('CreateFolderDialog', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('rejects an empty name before sending anything', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: /Create folder/i }))
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts the folder under the id the API gave for this folder', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: 'f9', name: 'Legal', type: 'FOLDER' }))
    vi.stubGlobal('fetch', fetchMock)
    const { onClose } = renderDialog()
    await submit('Legal')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ parentId: ROOT_ID, name: 'Legal' })
  })

  it('invalidates the room-root listing, which is keyed on no parent at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ id: 'f9', name: 'Legal', type: 'FOLDER' })))
    const { client, onClose } = renderDialog()
    await submit('Legal')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    // The folder was created under `ROOT_ID`, so an invalidation keyed on that id would
    // miss the only listing that has to show it.
    await waitFor(() => expect(client.getQueryState(rootListingKey)?.isInvalidated).toBe(true))
  })

  it('shows a 409 beside the field instead of closing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ code: 'NAME_CONFLICT', message: 'That name is taken in this folder' }, 409)),
    )
    const { onClose } = renderDialog()
    await submit('Legal')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/taken/i))
    expect(onClose).not.toHaveBeenCalled()
  })
})
