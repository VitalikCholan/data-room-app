import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { NodeTable } from './NodeTable'
import { AccessContextProvider } from '../access/AccessProvider'
import type { NodeItem } from './hooks/useNodeList'

const items: NodeItem[] = [
  { id: 'f1', type: 'FOLDER', name: 'Financials', sizeBytes: null, updatedAt: new Date().toISOString(), currentVersionId: null },
  { id: 'd1', type: 'FILE', name: 'MSA.pdf', sizeBytes: 2048, updatedAt: new Date().toISOString(), currentVersionId: 'v1' },
]

function renderTable(role: 'OWNER' | 'VIEWER', props: Partial<React.ComponentProps<typeof NodeTable>> = {}) {
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
    expect(screen.getByRole('link', { name: 'Financials' }).getAttribute('href')).toBe('/rooms/r1/f/f1')
    expect(screen.getByRole('link', { name: 'MSA.pdf' }).getAttribute('href')).toBe('/rooms/r1/file/d1')
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
    expect(screen.queryByText('Delete')).toBeNull()
    expect(screen.getByText('Open')).toBeTruthy()
  })

  it('shows the loading skeleton instead of an empty state while fetching', () => {
    renderTable('OWNER', { items: [], isLoading: true })
    expect(screen.queryByText(/Drop PDFs/i)).toBeNull()
  })

  it('shows a load-more control when another page exists', async () => {
    const onLoadMore = vi.fn()
    renderTable('OWNER', { hasMore: true, onLoadMore })
    await userEvent.click(screen.getByRole('button', { name: /Load more/i }))
    expect(onLoadMore).toHaveBeenCalled()
  })
})
