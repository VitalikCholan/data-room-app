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
 * KEEP_BOTH and NEW_VERSION are the API's `onConflict` enum: one stores the file under a
 * numbered name, the other uploads into the file already there as its next version.
 * CANCEL is client-side only — it drops the task without asking the server anything.
 */
export type ConflictStrategy = 'KEEP_BOTH' | 'NEW_VERSION'
export type ConflictChoice = ConflictStrategy | 'CANCEL'

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
  /** Everything enqueued in one drop or one file-picker choice. The unit the user answers for. */
  batchId: string
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
  /** Set only on a second attempt: the strategy the user chose, resent to presign. */
  onConflict?: ConflictStrategy
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
  /**
   * "Do the same for the rest of this batch", remembered rather than applied once. The
   * concurrency cap means later files of a batch presign after the prompt is already
   * gone, and they must follow the answer instead of raising a second one.
   */
  batchChoices: Record<string, ConflictChoice>
  onUploaded?: (task: UploadTask) => void
  setOnUploaded: (callback: (task: UploadTask) => void) => void
  enqueue: (files: File[], roomId: string, parentId: string) => Promise<void>
  resolveConflict: (taskId: string, choice: ConflictChoice, applyToAll: boolean) => Promise<void>
  cancel: (taskId: string) => void
  retry: (taskId: string) => Promise<void>
  clearFinished: () => void
  activeCount: () => number
  pendingConflict: () => UploadTask | undefined
  /** Scoped to a batch when one is named, because a batch is what a single answer covers. */
  parkedCount: (batchId?: string) => number
}

const RUNNING: ReadonlySet<UploadStatus> = new Set<UploadStatus>([
  'presigning',
  'uploading',
  'confirming',
])
const ACTIVE: ReadonlySet<UploadStatus> = new Set<UploadStatus>([
  'queued',
  'presigning',
  'uploading',
  'confirming',
  'needs-decision',
])

let sequence = 0
const nextId = () => `upload-${(sequence += 1)}`
let batchSequence = 0
const nextBatchId = () => `batch-${(batchSequence += 1)}`

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

/**
 * The local pre-flight, and the only type check there is. Presign declares
 * `application/pdf` and the PUT sends that Content-Type, so the API's confirm re-reads
 * the size honestly from `contentLength` but sees nothing of the type beyond what this
 * client claimed. A file refused here is refused nowhere else — which is why `retry`
 * asks again instead of trusting a task that is already in the queue.
 */
function localRejection(file: File): string | undefined {
  if (file.type !== ALLOWED_TYPE) return 'Only PDF files are supported'
  if (file.size > MAX_BYTES) return 'Files must be 50 MB or smaller'
  return undefined
}

/**
 * Lives outside the router on purpose: an upload started in one folder must keep
 * running while the user browses elsewhere, so its state cannot hang off a route.
 */
export const useUploadStore = create<UploadStore>((set, get) => {
  const patch = (id: string, changes: Partial<UploadTask>) =>
    set((state) => ({
      tasks: state.tasks.map((task) => (task.id === id ? { ...task, ...changes } : task)),
    }))

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

  /** Cancel is a status, so every checkpoint below asks the store rather than a local flag. */
  const isCanceled = (taskId: string) =>
    get().tasks.find((candidate) => candidate.id === taskId)?.status === 'canceled'

  /**
   * A 409 arrives per file; the user answers per batch. If this batch was already
   * answered, the answer is applied silently — no second prompt for the files that only
   * reached the server after the dialog closed.
   */
  function applyConflict(taskId: string, batchId: string, conflict: ConflictInfo | undefined) {
    const decided = get().batchChoices[batchId]
    if (decided === 'CANCEL') patch(taskId, { status: 'canceled', conflict: undefined })
    else if (decided) patch(taskId, { status: 'queued', onConflict: decided, conflict: undefined })
    // Park it and upload nothing until the user decides.
    else patch(taskId, { status: 'needs-decision', conflict })
  }

  async function run(taskId: string) {
    const task = get().tasks.find((candidate) => candidate.id === taskId)
    if (!task) return

    const controller = new AbortController()
    setUploadProgress(taskId, 0)
    patch(taskId, { status: 'presigning', progress: 0, error: undefined, controller })

    let presigned: PresignResponse
    try {
      presigned = await api.post<PresignResponse>(
        `/rooms/${task.roomId}/uploads/presign`,
        {
          parentId: task.parentId,
          name: task.file.name,
          sizeBytes: task.file.size,
          mimeType: ALLOWED_TYPE,
          ...(task.onConflict ? { onConflict: task.onConflict } : {}),
        },
        // Cancel has to reach this request too: without the signal, pressing it while
        // "Preparing" aborted nothing and the file went on to upload and report Uploaded.
        { signal: controller.signal },
      )
    } catch (error) {
      if (isAbort(error) || isCanceled(taskId)) patch(taskId, { status: 'canceled' })
      // A conflict the server still reports after a strategy was sent is a real failure,
      // not another question — asking again would loop forever.
      else if (error instanceof ApiError && error.code === 'NAME_CONFLICT' && !task.onConflict) {
        applyConflict(taskId, task.batchId, error.details as ConflictInfo | undefined)
      } else {
        patch(taskId, {
          status: 'error',
          error: error instanceof ApiError ? error.message : 'Could not start the upload',
        })
      }
      pump()
      return
    }
    // The request may have completed before the abort reached it, leaving nothing to
    // catch. The status is then the only thing that says the user stopped waiting.
    if (isCanceled(taskId)) {
      pump()
      return
    }

    patch(taskId, {
      status: 'uploading',
      nodeId: presigned.nodeId,
      versionId: presigned.versionId,
      // KEEP_BOTH may have suffixed the name, and NEW_VERSION answers with the existing
      // node's id rather than a fresh one; show what the room will actually hold.
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
      if (isAbort(error) || isCanceled(taskId)) {
        // The reserved node stays PENDING, is excluded from every listing, and the
        // server's sweep collects it.
        patch(taskId, { status: 'canceled' })
      } else {
        patch(taskId, { status: 'error', error: 'Upload failed — retry' })
      }
      pump()
      return
    }
    if (isCanceled(taskId)) {
      pump()
      return
    }

    setUploadProgress(taskId, 100)
    patch(taskId, { status: 'confirming', progress: 100 })
    try {
      await api.post(
        `/uploads/${presigned.nodeId}/confirm`,
        { versionId: presigned.versionId },
        { signal: controller.signal },
      )
      // No cancel check here on purpose: confirm has returned, so the version really is
      // ACTIVE and the file really is in the room. Reporting anything but Uploaded would
      // hide a file that exists.
      patch(taskId, { status: 'done' })
      const finished = get().tasks.find((candidate) => candidate.id === taskId)
      if (finished) get().onUploaded?.(finished)
    } catch (error) {
      if (isAbort(error) || isCanceled(taskId)) patch(taskId, { status: 'canceled' })
      else {
        // Confirm is where size is really enforced, so its message is the one worth
        // showing verbatim.
        patch(taskId, {
          status: 'error',
          error: error instanceof ApiError ? error.message : 'Could not finish the upload',
        })
      }
    }
    pump()
  }

  return {
    tasks: [],
    batchChoices: {},
    setOnUploaded: (callback) => set({ onUploaded: callback }),

    enqueue: async (files, roomId, parentId) => {
      const batchId = nextBatchId()
      const added: UploadTask[] = files.map((file) => {
        const base = { id: nextId(), batchId, file, roomId, parentId, name: file.name, progress: 0 }
        // Refused before any request, and the last word on the type: see localRejection.
        const rejection = localRejection(file)
        return rejection
          ? { ...base, status: 'error' as const, error: rejection }
          : { ...base, status: 'queued' as const }
      })
      set((state) => ({ tasks: [...state.tasks, ...added] }))
      pump()
    },

    resolveConflict: async (taskId, choice, applyToAll) => {
      const asked = get().tasks.find((task) => task.id === taskId)
      if (!asked) return
      // Remembered before anything is patched: the rest of the batch may still be
      // presigning, and those files read this on their way back with a 409.
      if (applyToAll)
        set((state) => ({ batchChoices: { ...state.batchChoices, [asked.batchId]: choice } }))

      const parked = get().tasks.filter((task) => task.status === 'needs-decision')
      // Scoped to the batch: "the rest of this batch" is what the checkbox promised, and
      // a second drop into another folder is a different question.
      const targets = applyToAll
        ? parked.filter((task) => task.batchId === asked.batchId)
        : parked.filter((task) => task.id === taskId)

      for (const task of targets) {
        if (choice === 'CANCEL') patch(task.id, { status: 'canceled', conflict: undefined })
        else patch(task.id, { status: 'queued', onConflict: choice, conflict: undefined })
      }
      pump()
    },

    cancel: (taskId) => {
      const task = get().tasks.find((candidate) => candidate.id === taskId)
      if (!task || !ACTIVE.has(task.status)) return
      task.controller?.abort()
      // Marked here as well as in the abort's own catch: a request that already resolved
      // has nothing left to abort, so the status is what stops `run` at its next
      // checkpoint. Confirm is the one step past the point of no return — see `run`.
      patch(taskId, { status: 'canceled' })
    },

    // Always from presign: a presigned url is only valid for fifteen minutes, so a
    // retry that reused it would upload into an expired signature.
    retry: async (taskId) => {
      const task = get().tasks.find((candidate) => candidate.id === taskId)
      if (!task) return
      const rejection = localRejection(task.file)
      if (rejection) {
        // Re-guarded rather than re-queued: presign would declare application/pdf for
        // these bytes whatever they are, and confirm believes that declaration — so a
        // retry of a locally-refused file is how a text file becomes an ACTIVE PDF.
        patch(taskId, { status: 'error', error: rejection, progress: 0 })
        return
      }
      patch(taskId, { status: 'queued', progress: 0, error: undefined, conflict: undefined })
      pump()
    },

    clearFinished: () =>
      set((state) => {
        const kept = state.tasks.filter(
          (task) => task.status !== 'done' && task.status !== 'canceled',
        )
        const keptIds = new Set(kept.map((task) => task.id))
        for (const task of state.tasks) if (!keptIds.has(task.id)) forgetUploadProgress(task.id)
        // A batch with nobody left in it can never be asked about again.
        const live = new Set(kept.map((task) => task.batchId))
        return {
          tasks: kept,
          batchChoices: Object.fromEntries(
            Object.entries(state.batchChoices).filter(([batchId]) => live.has(batchId)),
          ),
        }
      }),

    activeCount: () => get().tasks.filter((task) => ACTIVE.has(task.status)).length,

    pendingConflict: () => get().tasks.find((task) => task.status === 'needs-decision'),

    parkedCount: (batchId) =>
      get().tasks.filter(
        (task) => task.status === 'needs-decision' && (!batchId || task.batchId === batchId),
      ).length,
  }
})
