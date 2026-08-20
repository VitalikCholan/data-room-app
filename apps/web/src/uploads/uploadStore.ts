import { create } from 'zustand'
import { api, ApiError } from '../api/client'
import { forgetUploadProgress, setUploadProgress } from './uploadProgress'
import { putWithProgress } from './putWithProgress'

export const MAX_CONCURRENT = 3
export const MAX_BYTES = 50 * 1024 * 1024
export const ALLOWED_TYPE = 'application/pdf'

export type ConflictInfo = {
  existingNodeId: string
  /** Absent when a folder holds the name: a folder is never versioned. */
  currentVersionNo?: number
  existingUpdatedAt: string
}

/**
 * KEEP_BOTH is the API's entire `onConflict` enum (Ruling 32) — there is no
 * NEW_VERSION, and sending one would 422. CANCEL is client-side only: it drops the
 * task without asking the server anything.
 */
export type ConflictChoice = 'KEEP_BOTH' | 'CANCEL'

export type UploadStatus =
  | 'queued'
  | 'presigning'
  | 'needs-decision'
  | 'uploading'
  | 'confirming'
  | 'done'
  | 'error'
  | 'canceled'

export type UploadTask = {
  id: string
  file: File
  roomId: string
  parentId: string
  name: string
  status: UploadStatus
  /** Coarse only: 0 while preparing, 100 once the bytes are in. Ticks live in uploadProgress. */
  progress: number
  error?: string
  nodeId?: string
  versionId?: string
  conflict?: ConflictInfo
  onConflict?: 'KEEP_BOTH'
  controller?: AbortController
}

type PresignResponse = {
  nodeId: string
  versionId: string
  versionNo: number
  blobKey: string
  uploadUrl: string
  expiresAt: string
  name: string
}

type UploadStore = {
  tasks: UploadTask[]
  onUploaded?: (task: UploadTask) => void
  setOnUploaded: (callback: (task: UploadTask) => void) => void
  enqueue: (files: File[], roomId: string, parentId: string) => Promise<void>
  resolveConflict: (taskId: string, choice: ConflictChoice, applyToAll: boolean) => Promise<void>
  cancel: (taskId: string) => void
  retry: (taskId: string) => Promise<void>
  clearFinished: () => void
  activeCount: () => number
  pendingConflict: () => UploadTask | undefined
  parkedCount: () => number
}

const RUNNING: ReadonlySet<UploadStatus> = new Set<UploadStatus>(['presigning', 'uploading', 'confirming'])
const ACTIVE: ReadonlySet<UploadStatus> = new Set<UploadStatus>([
  'queued',
  'presigning',
  'uploading',
  'confirming',
  'needs-decision',
])

let sequence = 0
const nextId = () => `upload-${(sequence += 1)}`

/**
 * Lives outside the router on purpose: an upload started in one folder must keep
 * running while the user browses elsewhere, so its state cannot hang off a route.
 */
export const useUploadStore = create<UploadStore>((set, get) => {
  const patch = (id: string, changes: Partial<UploadTask>) =>
    set((state) => ({ tasks: state.tasks.map((task) => (task.id === id ? { ...task, ...changes } : task)) }))

  /** Starts as many queued tasks as the concurrency budget allows. */
  function pump() {
    const running = get().tasks.filter((task) => RUNNING.has(task.status)).length
    const slots = MAX_CONCURRENT - running
    if (slots <= 0) return
    for (const task of get()
      .tasks.filter((task) => task.status === 'queued')
      .slice(0, slots)) {
      void run(task.id)
    }
  }

  async function run(taskId: string) {
    const task = get().tasks.find((candidate) => candidate.id === taskId)
    if (!task) return

    const controller = new AbortController()
    setUploadProgress(taskId, 0)
    patch(taskId, { status: 'presigning', progress: 0, error: undefined, controller })

    let presigned: PresignResponse
    try {
      presigned = await api.post<PresignResponse>(`/rooms/${task.roomId}/uploads/presign`, {
        parentId: task.parentId,
        name: task.file.name,
        sizeBytes: task.file.size,
        mimeType: ALLOWED_TYPE,
        ...(task.onConflict ? { onConflict: task.onConflict } : {}),
      })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NAME_CONFLICT') {
        // Park it and upload nothing. The user decides once, for the whole batch.
        patch(taskId, { status: 'needs-decision', conflict: error.details as ConflictInfo | undefined })
      } else {
        patch(taskId, {
          status: 'error',
          error: error instanceof ApiError ? error.message : 'Could not start the upload',
        })
      }
      pump()
      return
    }

    patch(taskId, {
      status: 'uploading',
      nodeId: presigned.nodeId,
      versionId: presigned.versionId,
      // KEEP_BOTH may have suffixed the name; show what the room will actually hold.
      name: presigned.name,
    })

    try {
      await putWithProgress(
        presigned.uploadUrl,
        task.file,
        (fraction) => setUploadProgress(taskId, Math.round(fraction * 100)),
        controller.signal,
      )
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // The reserved node stays PENDING, is excluded from every listing, and the
        // server's sweep collects it.
        patch(taskId, { status: 'canceled' })
      } else {
        patch(taskId, { status: 'error', error: 'Upload failed — retry' })
      }
      pump()
      return
    }

    setUploadProgress(taskId, 100)
    patch(taskId, { status: 'confirming', progress: 100 })
    try {
      await api.post(`/uploads/${presigned.nodeId}/confirm`, { versionId: presigned.versionId })
      patch(taskId, { status: 'done' })
      const finished = get().tasks.find((candidate) => candidate.id === taskId)
      if (finished) get().onUploaded?.(finished)
    } catch (error) {
      // Confirm is where size and type are really enforced, so its message is the
      // one worth showing verbatim.
      patch(taskId, {
        status: 'error',
        error: error instanceof ApiError ? error.message : 'Could not finish the upload',
      })
    }
    pump()
  }

  return {
    tasks: [],
    setOnUploaded: (callback) => set({ onUploaded: callback }),

    enqueue: async (files, roomId, parentId) => {
      const added: UploadTask[] = files.map((file) => {
        const base = { id: nextId(), file, roomId, parentId, name: file.name, progress: 0 }
        // Refused before any request. The API enforces both again on confirm — this
        // check is about not wasting the user's twenty minutes, not about security.
        if (file.type !== ALLOWED_TYPE) return { ...base, status: 'error' as const, error: 'Only PDF files are supported' }
        if (file.size > MAX_BYTES) return { ...base, status: 'error' as const, error: 'Files must be 50 MB or smaller' }
        return { ...base, status: 'queued' as const }
      })
      set((state) => ({ tasks: [...state.tasks, ...added] }))
      pump()
    },

    resolveConflict: async (taskId, choice, applyToAll) => {
      const parked = get().tasks.filter((task) => task.status === 'needs-decision')
      const targets = applyToAll ? parked : parked.filter((task) => task.id === taskId)

      for (const task of targets) {
        if (choice === 'CANCEL') patch(task.id, { status: 'canceled', conflict: undefined })
        else patch(task.id, { status: 'queued', onConflict: 'KEEP_BOTH', conflict: undefined })
      }
      pump()
    },

    cancel: (taskId) => {
      const task = get().tasks.find((candidate) => candidate.id === taskId)
      if (!task) return
      task.controller?.abort()
      // An abort resolves through the upload's own catch; anything not in flight has
      // no request to abort, so it is marked here.
      if (!RUNNING.has(task.status)) patch(taskId, { status: 'canceled' })
    },

    // Always from presign: a presigned url is only valid for fifteen minutes, so a
    // retry that reused it would upload into an expired signature.
    retry: async (taskId) => {
      patch(taskId, { status: 'queued', progress: 0, error: undefined, conflict: undefined })
      pump()
    },

    clearFinished: () =>
      set((state) => {
        const kept = state.tasks.filter((task) => task.status !== 'done' && task.status !== 'canceled')
        const keptIds = new Set(kept.map((task) => task.id))
        for (const task of state.tasks) if (!keptIds.has(task.id)) forgetUploadProgress(task.id)
        return { tasks: kept }
      }),

    activeCount: () => get().tasks.filter((task) => ACTIVE.has(task.status)).length,

    pendingConflict: () => get().tasks.find((task) => task.status === 'needs-decision'),

    parkedCount: () => get().tasks.filter((task) => task.status === 'needs-decision').length,
  }
})
