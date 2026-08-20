/**
 * Progress is a transient value: a 50 MB upload fires hundreds of ticks, and putting
 * each one in the zustand store would re-render the queue panel, every queue row and
 * every one of their children for a one-pixel change. So ticks live here instead, in
 * a Map keyed by task id with per-task listeners — `useSyncExternalStore` in the
 * progress bar makes each tick re-render exactly one leaf element.
 *
 * The store still records the coarse transitions (0 on start, 100 on confirm); this
 * module only carries what happens between them.
 */
const percentByTask = new Map<string, number>()
const listenersByTask = new Map<string, Set<() => void>>()

export function setUploadProgress(taskId: string, percent: number) {
  // Identical values are dropped: a bar cannot show 43% differently from 43%.
  if (percentByTask.get(taskId) === percent) return
  percentByTask.set(taskId, percent)
  const listeners = listenersByTask.get(taskId)
  if (listeners) for (const listener of listeners) listener()
}

export const getUploadProgress = (taskId: string) => percentByTask.get(taskId) ?? 0

export function subscribeUploadProgress(taskId: string, listener: () => void) {
  let listeners = listenersByTask.get(taskId)
  if (!listeners) {
    listeners = new Set()
    listenersByTask.set(taskId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) listenersByTask.delete(taskId)
  }
}

/** Called when a task leaves the queue, so a long session does not accumulate ids. */
export function forgetUploadProgress(taskId: string) {
  percentByTask.delete(taskId)
}
