import { FileText, Folder, MoreHorizontal } from 'lucide-react'
import { memo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAccess } from '../access/AccessProvider'
import { Button } from '../components/ui/button'
import {
  DropdownContent,
  DropdownItem,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
} from '../components/ui/dropdown-menu'
import { cn } from '../lib/cn'
import { formatBytes, formatRelativeDate } from '../lib/format'
import { NODE_DRAG_TYPE } from './dragTypes'
import type { NodeItem } from './hooks/useNodeList'

export type NodeRowActions = {
  onRename: (node: NodeItem) => void
  onMove: (node: NodeItem) => void
  onDelete: (node: NodeItem) => void
  onShare: (node: NodeItem) => void
  onDropOnFolder: (sourceId: string, targetFolderId: string) => void
}

/**
 * Presentational: no queries, no mutations. Everything arrives as a prop, and the row
 * is memoized so one folder's drop-target state does not re-render the whole listing.
 */
export const NodeRow = memo(function NodeRow({
  roomId,
  node,
  actions,
}: {
  roomId: string
  node: NodeItem
  actions: NodeRowActions
}) {
  const { isOwner } = useAccess()
  const navigate = useNavigate()
  const [isDropTarget, setIsDropTarget] = useState(false)
  const href = node.type === 'FOLDER' ? `/rooms/${roomId}/f/${node.id}` : `/rooms/${roomId}/file/${node.id}`

  return (
    <div
      className={cn(
        'flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 hover:bg-muted/60',
        isDropTarget && 'bg-accent/10 ring-1 ring-inset ring-accent',
      )}
      draggable={isOwner}
      onDragStart={(event) => event.dataTransfer.setData(NODE_DRAG_TYPE, node.id)}
      onDragOver={(event) => {
        if (!isOwner || node.type !== 'FOLDER') return
        if (!event.dataTransfer.types.includes(NODE_DRAG_TYPE)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setIsDropTarget(true)
      }}
      onDragLeave={() => setIsDropTarget(false)}
      onDrop={(event) => {
        setIsDropTarget(false)
        if (!isOwner || node.type !== 'FOLDER') return
        // Checked before preventDefault and stopPropagation: an OS file drop must keep
        // bubbling to the upload drop zone, which is the only thing that handles files.
        if (!event.dataTransfer.types.includes(NODE_DRAG_TYPE)) return
        event.preventDefault()
        event.stopPropagation()
        const sourceId = event.dataTransfer.getData(NODE_DRAG_TYPE)
        // Dropping a folder onto itself is the one cycle the UI can rule out for free.
        if (sourceId && sourceId !== node.id) actions.onDropOnFolder(sourceId, node.id)
      }}
    >
      {node.type === 'FOLDER' ? (
        <Folder size={16} className="shrink-0 text-accent" />
      ) : (
        <FileText size={16} className="shrink-0 text-subtle" />
      )}

      <Link to={href} className="min-w-0 flex-1 truncate text-sm hover:text-accent">
        {node.name}
      </Link>

      <span className="w-20 shrink-0 text-right text-xs text-subtle">
        {node.type === 'FILE' && node.sizeBytes !== null ? formatBytes(node.sizeBytes) : '—'}
      </span>
      <span className="hidden w-28 shrink-0 text-right text-xs text-subtle sm:inline">
        {formatRelativeDate(node.updatedAt)}
      </span>

      <DropdownMenu>
        <DropdownTrigger asChild>
          <Button size="icon" variant="ghost" aria-label={`Actions for ${node.name}`}>
            <MoreHorizontal size={16} />
          </Button>
        </DropdownTrigger>
        <DropdownContent>
          <DropdownItem onSelect={() => void navigate(href)}>Open</DropdownItem>
          {isOwner ? (
            <>
              <DropdownSeparator />
              <DropdownItem onSelect={() => actions.onRename(node)}>Rename</DropdownItem>
              <DropdownItem onSelect={() => actions.onMove(node)}>Move…</DropdownItem>
              <DropdownItem onSelect={() => actions.onShare(node)}>Share…</DropdownItem>
              <DropdownSeparator />
              <DropdownItem danger onSelect={() => actions.onDelete(node)}>
                Delete
              </DropdownItem>
            </>
          ) : null}
        </DropdownContent>
      </DropdownMenu>
    </div>
  )
})
