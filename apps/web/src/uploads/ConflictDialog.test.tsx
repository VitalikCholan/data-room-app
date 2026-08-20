import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConflictDialog } from './ConflictDialog'
import { useUploadStore, type UploadTask } from './uploadStore'

const parked = (id: string, name: string, batchId = 'b1'): UploadTask => ({
  id,
  batchId,
  file: new File([new Uint8Array(8)], name, { type: 'application/pdf' }),
  roomId: 'r1',
  parentId: 'p1',
  name,
  status: 'needs-decision',
  progress: 0,
  conflict: { existingNodeId: 'n9', currentVersionNo: 2, existingUpdatedAt: new Date().toISOString() },
})

describe('ConflictDialog', () => {
  const resolveConflict = vi.fn()

  beforeEach(() => {
    resolveConflict.mockReset()
    useUploadStore.setState({ tasks: [], resolveConflict })
  })

  it('renders nothing when no task is waiting for a decision', () => {
    render(<ConflictDialog />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers keep-both and cancel only — the API has no other strategy', () => {
    useUploadStore.setState({ tasks: [parked('t1', 'invoice.pdf')] })
    render(<ConflictDialog />)
    expect(screen.getByRole('button', { name: /Keep both/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Don't upload/i })).toBeTruthy()
    expect(screen.queryByText(/new version/i)).toBeNull()
  })

  it('keeps both for one file when the batch has no other conflict', async () => {
    useUploadStore.setState({ tasks: [parked('t1', 'invoice.pdf')] })
    render(<ConflictDialog />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Keep both/i }))
    expect(resolveConflict).toHaveBeenCalledWith('t1', 'KEEP_BOTH', false)
  })

  it('answers the whole batch from one prompt when asked to', async () => {
    useUploadStore.setState({ tasks: [parked('t1', 'a.pdf'), parked('t2', 'b.pdf'), parked('t3', 'c.pdf')] })
    render(<ConflictDialog />)
    expect(screen.getByText(/2 remaining/i)).toBeTruthy()
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: /Keep both/i }))
    expect(resolveConflict).toHaveBeenCalledWith('t1', 'KEEP_BOTH', true)
  })

  it('counts only the conflicts one answer can cover', () => {
    // The second drop is its own batch, so "do the same for the rest" must not claim it.
    useUploadStore.setState({
      tasks: [parked('t1', 'a.pdf'), parked('t2', 'b.pdf'), parked('t3', 'c.pdf', 'b2')],
    })
    render(<ConflictDialog />)
    expect(screen.getByText(/1 remaining/i)).toBeTruthy()
  })

  it('cancels the upload rather than replacing the existing file', async () => {
    useUploadStore.setState({ tasks: [parked('t1', 'invoice.pdf')] })
    render(<ConflictDialog />)
    await userEvent.click(screen.getByRole('button', { name: /Don't upload/i }))
    expect(resolveConflict).toHaveBeenCalledWith('t1', 'CANCEL', false)
  })
})
