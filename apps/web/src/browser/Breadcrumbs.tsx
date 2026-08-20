import { ChevronRight } from 'lucide-react'
import { memo } from 'react'
import { Link } from 'react-router-dom'
import { NODE_DRAG_TYPE } from './dragTypes'
import type { Crumb } from './hooks/useNodeList'

/**
 * The API already truncates crumbs at the caller's scope root, so a guest sees the path
 * from the shared folder. Nothing here needs to know that.
 */
export const Breadcrumbs = memo(function Breadcrumbs({
  roomId,
  crumbs,
  onDropOnCrumb,
}: {
  roomId: string
  crumbs: Crumb[]
  onDropOnCrumb: (folderId: string, sourceId: string) => void
}) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1
        return (
          <span key={crumb.id} className="flex min-w-0 items-center gap-1">
            {index > 0 ? <ChevronRight size={14} className="shrink-0 text-subtle" /> : null}
            {isLast ? (
              <span className="truncate font-medium">{crumb.name}</span>
            ) : (
              <Link
                to={`/rooms/${roomId}/f/${crumb.id}`}
                className="truncate text-subtle hover:text-accent"
                onDragOver={(event) => {
                  // Only a row drag. An OS file drag advertises 'Files' and belongs to
                  // the upload drop zone, which must keep receiving it.
                  if (!event.dataTransfer.types.includes(NODE_DRAG_TYPE)) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(event) => {
                  if (!event.dataTransfer.types.includes(NODE_DRAG_TYPE)) return
                  event.preventDefault()
                  const sourceId = event.dataTransfer.getData(NODE_DRAG_TYPE)
                  if (sourceId) onDropOnCrumb(crumb.id, sourceId)
                }}
              >
                {crumb.name}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
})
