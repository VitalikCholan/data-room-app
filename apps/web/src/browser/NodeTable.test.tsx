import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { NodeTable } from './NodeTable'
import { AccessContextProvider } from '../access/AccessProvider'
import { OwnerOnly } from '../access/OwnerOnly'
import type { NodeItem } from './hooks/useNodeList'

const items: NodeItem[] = [
  {
    id: 'f1',
    type: 'FOLDER',
    name: 'Financials',
    sizeBytes: null,
    updatedAt: new Date().toISOString(),
    currentVersionId: null,
  },
  {
    id: 'd1',
    type: 'FILE',
    name: 'MSA.pdf',
    sizeBytes: 2048,
    updatedAt: new Date().toISOString(),
    currentVersionId: 'v1',
  },
]

/** The only payload a row-to-folder move ever carries. OS file drops advertise 'Files'. */
const nodeDrag = (sourceId: string) => ({
  dataTransfer: { types: ['application/x-node-id'], getData: () => sourceId, dropEffect: 'none' },
})

function renderTable(
  role: 'OWNER' | 'VIEWER',
  props: Partial<React.ComponentProps<typeof NodeTable>> = {},
) {
  return render(
    <MemoryRouter>
      <AccessContextProvider value={{ role, scopeRootId: 'root', isOwner: role === 'OWNER' }}>
        <NodeTable
          roomId="r1"
          items={items}
          isLoading={false}
          hasMore={false}
          onLoadMore={vi.fn()}
          onRename={vi.fn()}
          onMove={vi.fn()}
          onDelete={vi.fn()}
          onShare={vi.fn()}
          onDropOnFolder={vi.fn()}
          {...props}
        />
      </AccessContextProvider>
    </MemoryRouter>,
  )
}

describe('NodeTable', () => {
  it('renders folders and files with size only on files', () => {
    renderTable('OWNER')
    expect(screen.getByText('Financials')).toBeTruthy()
    expect(screen.getByText('MSA.pdf')).toBeTruthy()
    expect(screen.getByText('2 KB')).toBeTruthy()
  })

  it('links a folder to its route and a file to the viewer route', () => {
    renderTable('OWNER')
    expect(screen.getByRole('link', { name: 'Financials' }).getAttribute('href')).toBe(
      '/rooms/r1/f/f1',
    )
    expect(screen.getByRole('link', { name: 'MSA.pdf' }).getAttribute('href')).toBe(
      '/rooms/r1/file/d1',
    )
  })

  it('navigates in place when the caller supplies the guest callbacks', async () => {
    const onNavigateFolder = vi.fn()
    const onOpenFile = vi.fn()
    renderTable('VIEWER', { onNavigateFolder, onOpenFile })

    // No links at all: every owner route sits behind RequireAuth, and a url is a way up.
    expect(screen.queryByRole('link', { name: 'Financials' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Financials' }))
    expect(onNavigateFolder).toHaveBeenCalledWith('f1')

    // The menu's Open must agree with the name cell, or one of them leaves the share.
    await userEvent.click(screen.getByRole('button', { name: /Actions for MSA.pdf/i }))
    await userEvent.click(screen.getByText('Open'))
    expect(onOpenFile).toHaveBeenCalledWith(items[1])
  })

  it('offers row actions to an owner', async () => {
    const onRename = vi.fn()
    renderTable('OWNER', { onRename })
    await userEvent.click(screen.getByRole('button', { name: /Actions for MSA.pdf/i }))
    await userEvent.click(screen.getByText('Rename'))
    expect(onRename).toHaveBeenCalledWith(items[1])
  })

  it('hides every mutation action from a viewer', async () => {
    renderTable('VIEWER')
    await userEvent.click(screen.getByRole('button', { name: /Actions for MSA.pdf/i }))
    expect(screen.queryByText('Rename')).toBeNull()
    expect(screen.queryByText('Move…')).toBeNull()
    expect(screen.queryByText('Share…')).toBeNull()
    expect(screen.queryByText('Delete')).toBeNull()
    // Open is the whole menu for a viewer, and it must survive.
    expect(screen.getByText('Open')).toBeTruthy()
  })

  it('offers the empty-state action to an owner', async () => {
    const onCreate = vi.fn()
    renderTable('OWNER', {
      items: [],
      emptyAction: (
        <OwnerOnly>
          <button onClick={onCreate}>New folder</button>
        </OwnerOnly>
      ),
    })
    await userEvent.click(screen.getByRole('button', { name: 'New folder' }))
    expect(onCreate).toHaveBeenCalled()
    expect(screen.getByText(/Drop PDFs here/i)).toBeTruthy()
  })

  it('never offers the empty-state action to a viewer', () => {
    renderTable('VIEWER', {
      items: [],
      emptyAction: (
        <OwnerOnly>
          <button>New folder</button>
        </OwnerOnly>
      ),
    })
    expect(screen.getByText(/This folder is empty/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull()
    // The hint names actions a viewer will never be offered, so it stays away too.
    expect(screen.queryByText(/Drop PDFs here/i)).toBeNull()
  })

  it('shows the loading skeleton instead of an empty state while fetching', () => {
    renderTable('OWNER', { items: [], isLoading: true })
    expect(screen.queryByText(/Drop PDFs/i)).toBeNull()
  })

  it('moves a dragged row into the folder it is dropped on', () => {
    const onDropOnFolder = vi.fn()
    renderTable('OWNER', { onDropOnFolder })
    fireEvent.drop(screen.getByText('Financials').closest('div')!, nodeDrag('d1'))
    expect(onDropOnFolder).toHaveBeenCalledWith('d1', 'f1')
  })

  it('ignores a folder dropped on itself and a row dropped on a file', () => {
    const onDropOnFolder = vi.fn()
    renderTable('OWNER', { onDropOnFolder })
    fireEvent.drop(screen.getByText('Financials').closest('div')!, nodeDrag('f1'))
    fireEvent.drop(screen.getByText('MSA.pdf').closest('div')!, nodeDrag('f1'))
    expect(onDropOnFolder).not.toHaveBeenCalled()
  })

  it('lets an OS file drop pass through a row to the upload drop zone', () => {
    const onDropOnFolder = vi.fn()
    renderTable('OWNER', { onDropOnFolder })
    const escaped: boolean[] = []
    document.addEventListener('drop', (event) => escaped.push(event.defaultPrevented), {
      once: true,
    })
    fireEvent.drop(screen.getByText('Financials').closest('div')!, {
      dataTransfer: { types: ['Files'], getData: () => '' },
    })
    expect(onDropOnFolder).not.toHaveBeenCalled()
    // Neither consumed nor cancelled: the drop zone above still gets its turn.
    expect(escaped).toEqual([false])
  })

  it('never lets a viewer drag a row', () => {
    renderTable('VIEWER')
    expect(screen.getByText('Financials').closest('div')!.getAttribute('draggable')).toBe('false')
  })

  it('shows a load-more control when another page exists', async () => {
    const onLoadMore = vi.fn()
    renderTable('OWNER', { hasMore: true, onLoadMore })
    await userEvent.click(screen.getByRole('button', { name: /Load more/i }))
    expect(onLoadMore).toHaveBeenCalled()
  })
})
