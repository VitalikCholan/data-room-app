import { RotateCcw, X } from 'lucide-react'
import { memo } from 'react'
import { Button } from '../components/ui/button'
import { formatBytes } from '../lib/format'
import { UploadProgressBar } from './UploadProgressBar'
import { useUploadStore, type UploadStatus, type UploadTask } from './uploadStore'

const LABELS: Record<UploadStatus, string> = {
  queued: 'Waiting',
  presigning: 'Preparing',
  'needs-decision': 'Needs your decision',
  uploading: 'Uploading',
  confirming: 'Finishing',
  done: 'Uploaded',
  error: 'Failed',
  canceled: 'Canceled',
}

const CANCELLABLE: ReadonlySet<UploadStatus> = new Set<UploadStatus>([
  'queued',
  'presigning',
  'uploading',
  'confirming',
])

export const UploadQueueItem = memo(function UploadQueueItem({ task }: { task: UploadTask }) {
  const cancel = useUploadStore((state) => state.cancel)
  const retry = useUploadStore((state) => state.retry)
  const isFailed = task.status === 'error'

  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{task.name}</span>
        <span className="shrink-0 text-xs text-subtle">{formatBytes(task.file.size)}</span>
        {isFailed ? (
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Retry ${task.name}`}
            onClick={() => void retry(task.id)}
          >
            <RotateCcw size={14} />
          </Button>
        ) : null}
        {CANCELLABLE.has(task.status) ? (
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Cancel ${task.name}`}
            onClick={() => cancel(task.id)}
          >
            <X size={14} />
          </Button>
        ) : null}
      </div>

      <div className="mt-1 flex items-center gap-2">
        <UploadProgressBar taskId={task.id} isFailed={isFailed} />
        <span className={isFailed ? 'text-xs text-danger' : 'text-xs text-subtle'}>
          {task.error ?? LABELS[task.status]}
        </span>
      </div>
    </li>
  )
})
