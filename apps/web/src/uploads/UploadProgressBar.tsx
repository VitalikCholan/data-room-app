import { useCallback, useSyncExternalStore } from 'react'
import { getUploadProgress, subscribeUploadProgress } from './uploadProgress'

/**
 * The only thing a progress tick re-renders. It reads the transient channel rather
 * than the store, so hundreds of ticks per file cost one small element each and never
 * touch the queue panel, its siblings, or the listing behind them.
 */
export function UploadProgressBar({ taskId, isFailed }: { taskId: string; isFailed: boolean }) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeUploadProgress(taskId, listener),
    [taskId],
  )
  const getSnapshot = useCallback(() => getUploadProgress(taskId), [taskId])
  const percent = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return (
    <div
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1 flex-1 overflow-hidden rounded bg-border"
    >
      <div
        className={isFailed ? 'h-full bg-danger' : 'h-full bg-accent transition-[width]'}
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}
