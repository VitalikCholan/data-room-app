import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_CONCURRENT, useUploadStore } from './uploadStore'
import { getUploadProgress } from './uploadProgress'

const pdf = (name: string, size = 1024) => new File([new Uint8Array(size)], name, { type: 'application/pdf' })

const presignResponse = (over: Record<string, unknown> = {}) => ({
  nodeId: 'n1',
  versionId: 'v1',
  versionNo: 1,
  blobKey: 'k',
  uploadUrl: 'https://bucket.test/put',
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
  name: 'a.pdf',
  ...over,
})

// Hoisted so the store's own imports are replaced before it ever runs.
const apiMock = vi.hoisted(() => ({ post: vi.fn() }))
const putMock = vi.hoisted(() => ({ putWithProgress: vi.fn() }))

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return { ...actual, api: apiMock }
})
vi.mock('./putWithProgress', () => putMock)

const conflict = (details: Record<string, unknown> = {}) =>
  import('../api/client').then(
    ({ ApiError }) =>
      new ApiError(409, 'NAME_CONFLICT', '"a.pdf" already exists in this folder', {
        existingNodeId: 'n9',
        currentVersionNo: 2,
        existingUpdatedAt: '2026-08-01T00:00:00Z',
        ...details,
      }),
  )

const tasks = () => useUploadStore.getState().tasks

describe('uploadStore', () => {
  beforeEach(() => {
    useUploadStore.setState({ tasks: [] })
    apiMock.post.mockReset()
    putMock.putWithProgress.mockReset()
  })

  it('runs a task through presign, put and confirm', async () => {
    apiMock.post.mockImplementation((path: string) =>
      path.includes('presign') ? Promise.resolve(presignResponse()) : Promise.resolve({ id: 'n1', status: 'ACTIVE' }),
    )
    putMock.putWithProgress.mockResolvedValue(undefined)

    await useUploadStore.getState().enqueue([pdf('a.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(tasks()[0].status).toBe('done'))

    expect(apiMock.post.mock.calls[0]).toEqual([
      '/rooms/r1/uploads/presign',
      { parentId: 'p1', name: 'a.pdf', sizeBytes: 1024, mimeType: 'application/pdf' },
    ])
    expect(apiMock.post.mock.calls[1]).toEqual(['/uploads/n1/confirm', { versionId: 'v1' }])
  })

  it(`runs at most ${MAX_CONCURRENT} uploads at once`, async () => {
    let inFlight = 0
    let peak = 0
    apiMock.post.mockImplementation((path: string) =>
      path.includes('presign') ? Promise.resolve(presignResponse()) : Promise.resolve({}),
    )
    putMock.putWithProgress.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
    })

    await useUploadStore
      .getState()
      .enqueue([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf'), pdf('d.pdf'), pdf('e.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(tasks().every((task) => task.status === 'done')).toBe(true), { timeout: 3000 })
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT)
  })

  it('rejects a non-PDF locally without calling the API', async () => {
    await useUploadStore.getState().enqueue([new File(['x'], 'notes.txt', { type: 'text/plain' })], 'r1', 'p1')
    expect(tasks()[0].status).toBe('error')
    expect(tasks()[0].error).toMatch(/PDF/i)
    expect(apiMock.post).not.toHaveBeenCalled()
  })

  it('rejects a file over 50 MB locally', async () => {
    const huge = new File([new Uint8Array(10)], 'huge.pdf', { type: 'application/pdf' })
    Object.defineProperty(huge, 'size', { value: 50 * 1024 * 1024 + 1 })
    await useUploadStore.getState().enqueue([huge], 'r1', 'p1')
    expect(tasks()[0].error).toMatch(/50 MB/)
    expect(apiMock.post).not.toHaveBeenCalled()
  })

  it('parks a task in needs-decision on 409 and carries the conflict details', async () => {
    apiMock.post.mockRejectedValueOnce(await conflict())
    await useUploadStore.getState().enqueue([pdf('invoice.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(tasks()[0].status).toBe('needs-decision'))
    expect(tasks()[0].conflict).toMatchObject({ existingNodeId: 'n9', currentVersionNo: 2 })
  })

  it('survives a conflict on a folder name, which has no version number', async () => {
    apiMock.post.mockRejectedValueOnce(await conflict({ currentVersionNo: undefined }))
    await useUploadStore.getState().enqueue([pdf('Legal.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(tasks()[0].status).toBe('needs-decision'))
    expect(tasks()[0].conflict?.currentVersionNo).toBeUndefined()
  })

  it('resolveConflict KEEP_BOTH with applyToAll answers every parked task at once', async () => {
    apiMock.post.mockImplementation(async (path: string, body: { onConflict?: string }) => {
      if (path.includes('presign') && !body.onConflict) throw await conflict()
      if (path.includes('presign')) return presignResponse()
      return {}
    })
    putMock.putWithProgress.mockResolvedValue(undefined)

    await useUploadStore.getState().enqueue([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(tasks().filter((task) => task.status === 'needs-decision')).toHaveLength(3))

    await useUploadStore.getState().resolveConflict(tasks()[0].id, 'KEEP_BOTH', true)
    await vi.waitFor(() => expect(tasks().every((task) => task.status === 'done')).toBe(true))
    expect(
      apiMock.post.mock.calls.filter(
        ([path, body]) => (path as string).includes('presign') && (body as { onConflict?: string }).onConflict === 'KEEP_BOTH',
      ),
    ).toHaveLength(3)
  })

  it('cancelling one conflict drops only that task', async () => {
    apiMock.post.mockRejectedValue(await conflict())
    await useUploadStore.getState().enqueue([pdf('a.pdf'), pdf('b.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(tasks().filter((task) => task.status === 'needs-decision')).toHaveLength(2))

    const [first] = tasks()
    await useUploadStore.getState().resolveConflict(first.id, 'CANCEL', false)
    expect(tasks().find((task) => task.id === first.id)?.status).toBe('canceled')
    expect(tasks().filter((task) => task.status === 'needs-decision')).toHaveLength(1)
  })

  it('cancel aborts the request in flight and marks the task canceled', async () => {
    apiMock.post.mockImplementation((path: string) =>
      path.includes('presign') ? Promise.resolve(presignResponse()) : Promise.resolve({}),
    )
    putMock.putWithProgress.mockImplementation(
      (_url: string, _file: File, _onProgress: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        ),
    )

    await useUploadStore.getState().enqueue([pdf('slow.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(tasks()[0].status).toBe('uploading'))
    useUploadStore.getState().cancel(tasks()[0].id)
    await vi.waitFor(() => expect(tasks()[0].status).toBe('canceled'))
  })

  it('retry restarts from presign because the url may have expired', async () => {
    apiMock.post.mockRejectedValueOnce(new Error('network down'))
    await useUploadStore.getState().enqueue([pdf('a.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(tasks()[0].status).toBe('error'))

    apiMock.post.mockImplementation((path: string) =>
      path.includes('presign') ? Promise.resolve(presignResponse()) : Promise.resolve({}),
    )
    putMock.putWithProgress.mockResolvedValue(undefined)
    await useUploadStore.getState().retry(tasks()[0].id)
    await vi.waitFor(() => expect(tasks()[0].status).toBe('done'))
    expect(apiMock.post.mock.calls.filter(([path]) => (path as string).includes('presign'))).toHaveLength(2)
  })

  it('routes progress ticks around the store so a tick re-renders nothing but its own bar', async () => {
    apiMock.post.mockImplementation((path: string) =>
      path.includes('presign') ? Promise.resolve(presignResponse()) : Promise.resolve({}),
    )
    let notifications = 0
    const unsubscribe = useUploadStore.subscribe(() => {
      notifications += 1
    })
    putMock.putWithProgress.mockImplementation(async (_url: string, _file: File, onProgress: (n: number) => void) => {
      const before = notifications
      for (let sent = 1; sent <= 20; sent += 1) onProgress(sent / 20)
      // Twenty ticks, zero store writes: the queue panel and its siblings never hear them.
      expect(notifications).toBe(before)
    })

    await useUploadStore.getState().enqueue([pdf('a.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(tasks()[0].status).toBe('done'))
    unsubscribe()
    expect(getUploadProgress(tasks()[0].id)).toBe(100)
  })

  it('activeCount counts only work in flight', async () => {
    apiMock.post.mockImplementation((path: string) =>
      path.includes('presign') ? Promise.resolve(presignResponse()) : Promise.resolve({}),
    )
    putMock.putWithProgress.mockResolvedValue(undefined)
    await useUploadStore.getState().enqueue([pdf('a.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(tasks()[0].status).toBe('done'))
    expect(useUploadStore.getState().activeCount()).toBe(0)
  })

  it('clearFinished keeps only what is still going', async () => {
    apiMock.post.mockImplementation((path: string) =>
      path.includes('presign') ? Promise.resolve(presignResponse()) : Promise.resolve({}),
    )
    putMock.putWithProgress.mockResolvedValue(undefined)
    await useUploadStore.getState().enqueue([pdf('a.pdf'), new File(['x'], 'b.txt', { type: 'text/plain' })], 'r1', 'p1')
    await vi.waitFor(() => expect(tasks()[0].status).toBe('done'))
    useUploadStore.getState().clearFinished()
    // The failure stays: it is the only record the user has that the file was refused.
    expect(tasks().map((task) => task.name)).toEqual(['b.txt'])
  })
})
