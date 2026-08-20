import { useState } from 'react'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { formatRelativeDate } from '../lib/format'
import { useUploadStore } from './uploadStore'

/**
 * One prompt for a whole batch. It offers exactly what the API can do: keep both under
 * a numbered name, or don't upload. There is no "replace" and no "new version" — the
 * `onConflict` enum has one member, and offering a second would 422 (Ruling 32).
 */
export function ConflictDialog() {
  const task = useUploadStore((state) => state.pendingConflict())
  // Counted inside the batch, because that is what one answer covers: a second drop into
  // another folder is a different question and gets its own prompt.
  const parkedInBatch = useUploadStore((state) => state.parkedCount(task?.batchId))
  const resolveConflict = useUploadStore((state) => state.resolveConflict)
  const [applyToAll, setApplyToAll] = useState(false)

  if (!task) return null
  const remaining = parkedInBatch - 1
  const existingUpdatedAt = task.conflict?.existingUpdatedAt

  return (
    <Dialog
      open
      onOpenChange={() => void resolveConflict(task.id, 'CANCEL', applyToAll)}
      title={`"${task.name}" already exists in this folder`}
      description={
        existingUpdatedAt ? `The file already there was last changed ${formatRelativeDate(existingUpdatedAt)}.` : undefined
      }
    >
      <div className="flex flex-col gap-2">
        <Button variant="primary" onClick={() => void resolveConflict(task.id, 'KEEP_BOTH', applyToAll)}>
          Keep both — upload as a numbered copy
        </Button>
        <Button onClick={() => void resolveConflict(task.id, 'CANCEL', applyToAll)}>Don&apos;t upload this file</Button>
        {/* The exact suffix is the server's call: it picks the first free number. */}
        <p className="text-xs text-subtle">Keeping both stores the new file as “{numberedExample(task.name)}”.</p>

        {remaining > 0 ? (
          <label className="mt-2 flex items-center gap-2 text-sm text-subtle">
            <input type="checkbox" checked={applyToAll} onChange={(event) => setApplyToAll(event.target.checked)} />
            Do the same for the {remaining} remaining {remaining === 1 ? 'conflict' : 'conflicts'} in this batch
          </label>
        ) : null}
      </div>
    </Dialog>
  )
}

/** Mirrors the server's naming so the preview is not a surprise: "invoice (2).pdf". */
function numberedExample(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (2)${name.slice(dot)}` : `${name} (2)`
}
