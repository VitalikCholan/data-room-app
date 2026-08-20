import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../components/ui/button'
import { UploadQueueItem } from './UploadQueueItem'
import { useUploadStore } from './uploadStore'

/**
 * Mounted outside the routes so an upload started in one folder keeps its panel while
 * the user browses somewhere else. It renders nothing until there is a queue.
 */
export function UploadQueuePanel() {
  const tasks = useUploadStore((state) => state.tasks)
  const clearFinished = useUploadStore((state) => state.clearFinished)
  // A derived boolean, not the count of a moving list: this only flips twice per batch.
  const activeCount = useUploadStore((state) => state.activeCount())
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Losing an upload in flight to a stray tab close is worth one confirmation prompt.
  // It cannot be passive: the whole point is preventDefault.
  useEffect(() => {
    if (!activeCount) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [activeCount])

  if (tasks.length === 0) return null
  const doneCount = tasks.filter((task) => task.status === 'done').length
  const failedCount = tasks.filter((task) => task.status === 'error').length

  return (
    <aside className="fixed bottom-4 right-4 z-20 w-80 overflow-hidden rounded-lg border border-border bg-surface shadow-panel">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        {/*
          A batch that failed outright used to head itself "0 uploaded", which reads as
          nothing having happened. The failures are named, because they are the reason
          the panel is still on screen.
        */}
        <span className="flex-1 text-sm font-medium">
          {activeCount > 0
            ? `Uploading ${activeCount} ${activeCount === 1 ? 'file' : 'files'}`
            : failedCount === 0
              ? `${doneCount} uploaded`
              : doneCount === 0
                ? `${failedCount} failed`
                : `${doneCount} uploaded, ${failedCount} failed`}
        </span>
        {activeCount === 0 ? (
          <Button size="sm" variant="ghost" onClick={clearFinished}>
            Clear
          </Button>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          aria-label={isCollapsed ? 'Expand uploads' : 'Collapse uploads'}
          onClick={() => setIsCollapsed((previous) => !previous)}
        >
          {isCollapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </Button>
      </header>
      {isCollapsed ? null : (
        <ul className="max-h-72 divide-y divide-border overflow-auto">
          {tasks.map((task) => (
            <UploadQueueItem key={task.id} task={task} />
          ))}
        </ul>
      )}
    </aside>
  )
}
