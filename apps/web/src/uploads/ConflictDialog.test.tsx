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
  conflict: {
    existingNodeId: 'n9',
    currentVersionNo: 2,
    existingUpdatedAt: new Date().toISOString(),
  },
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

  it('offers all three of the API strategies against an existing file', () => {
    useUploadStore.setState({ tasks: [parked('t1', 'invoice.pdf')] })
    render(<ConflictDialog />)
    expect(screen.getByRole('button', { name: /Keep both/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /new version/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Don't upload/i })).toBeTruthy()
    // The number it will get, so "new version" is not a guess about what happens next.
    expect(screen.getByText(/version 3/i)).toBeTruthy()
  })

  it('uploads as a new version of the existing file when asked to', async () => {
    useUploadStore.setState({ tasks: [parked('t1', 'invoice.pdf')] })
    render(<ConflictDialog />)
    await userEvent.click(screen.getByRole('button', { name: /new version/i }))
    expect(resolveConflict).toHaveBeenCalledWith('t1', 'NEW_VERSION', false)
  })

  it('does not offer a new version when a folder holds the name, because a folder has none', () => {
    const folderClash = parked('t1', 'Legal.pdf')
    useUploadStore.setState({
      tasks: [
        { ...folderClash, conflict: { ...folderClash.conflict!, currentVersionNo: undefined } },
      ],
    })
    render(<ConflictDialog />)
    expect(screen.getByRole('button', { name: /Keep both/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /new version/i })).toBeNull()
  })

  it('answers the whole batch with a new version too', async () => {
    useUploadStore.setState({ tasks: [parked('t1', 'a.pdf'), parked('t2', 'b.pdf')] })
    render(<ConflictDialog />)
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: /new version/i }))
    expect(resolveConflict).toHaveBeenCalledWith('t1', 'NEW_VERSION', true)
  })

  it('keeps both for one file when the batch has no other conflict', async () => {
    useUploadStore.setState({ tasks: [parked('t1', 'invoice.pdf')] })
    render(<ConflictDialog />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Keep both/i }))
    expect(resolveConflict).toHaveBeenCalledWith('t1', 'KEEP_BOTH', false)
  })

  it('answers the whole batch from one prompt when asked to', async () => {
    useUploadStore.setState({
      tasks: [parked('t1', 'a.pdf'), parked('t2', 'b.pdf'), parked('t3', 'c.pdf')],
    })
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
