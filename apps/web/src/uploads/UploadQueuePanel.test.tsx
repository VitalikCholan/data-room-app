import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UploadQueuePanel } from './UploadQueuePanel'
import { setUploadProgress } from './uploadProgress'
import { useUploadStore, type UploadStatus, type UploadTask } from './uploadStore'

const task = (id: string, name: string, status: UploadStatus, error?: string): UploadTask => ({
  id,
  batchId: 'b1',
  file: new File([new Uint8Array(2048)], name, { type: 'application/pdf' }),
  roomId: 'r1',
  parentId: 'p1',
  name,
  status,
  progress: status === 'done' ? 100 : 0,
  error,
})

describe('UploadQueuePanel', () => {
  const cancel = vi.fn()
  const retry = vi.fn()

  beforeEach(() => {
    cancel.mockReset()
    retry.mockReset()
    useUploadStore.setState({ tasks: [], cancel, retry })
  })

  it('stays out of the way while the queue is empty', () => {
    render(<UploadQueuePanel />)
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('lists every file with its state', () => {
    useUploadStore.setState({ tasks: [task('t1', 'a.pdf', 'uploading'), task('t2', 'b.pdf', 'done')] })
    render(<UploadQueuePanel />)
    expect(screen.getByText('a.pdf')).toBeTruthy()
    expect(screen.getByText('Uploading')).toBeTruthy()
    expect(screen.getByText('Uploaded')).toBeTruthy()
  })

  it('cancels an upload in flight and retries a failed one', async () => {
    useUploadStore.setState({
      tasks: [task('t1', 'a.pdf', 'uploading'), task('t2', 'b.pdf', 'error', 'Upload failed — retry')],
    })
    render(<UploadQueuePanel />)
    await userEvent.click(screen.getByRole('button', { name: /Cancel a.pdf/i }))
    expect(cancel).toHaveBeenCalledWith('t1')
    await userEvent.click(screen.getByRole('button', { name: /Retry b.pdf/i }))
    expect(retry).toHaveBeenCalledWith('t2')
  })

  it('says a batch failed instead of heading itself "0 uploaded"', () => {
    useUploadStore.setState({
      tasks: [task('t1', 'a.pdf', 'error', 'Upload failed — retry'), task('t2', 'b.pdf', 'error', 'Only PDF files are supported')],
    })
    render(<UploadQueuePanel />)
    expect(screen.getByText('2 failed')).toBeTruthy()
    expect(screen.queryByText('0 uploaded')).toBeNull()
  })

  it('counts what got through beside what did not', () => {
    useUploadStore.setState({ tasks: [task('t1', 'a.pdf', 'done'), task('t2', 'b.pdf', 'error', 'Upload failed — retry')] })
    render(<UploadQueuePanel />)
    expect(screen.getByText('1 uploaded, 1 failed')).toBeTruthy()
  })

  it('follows progress ticks without any store write', async () => {
    useUploadStore.setState({ tasks: [task('t1', 'a.pdf', 'uploading')] })
    render(<UploadQueuePanel />)
    let storeWrites = 0
    const unsubscribe = useUploadStore.subscribe(() => {
      storeWrites += 1
    })
    setUploadProgress('t1', 42)
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42'))
    unsubscribe()
    expect(storeWrites).toBe(0)
  })
})
