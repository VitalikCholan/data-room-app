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
  /**
   * Supplied by the guest view only: navigate in place instead of routing. Every owner
   * route sits behind `RequireAuth`, so a guest following one of those links would be
   * bounced to the sign-in page — and there would be a url they could edit their way up
   * from. Absent for the owner, whose rows stay ordinary links.
   */
  onNavigateFolder?: (nodeId: string) => void
  /** Supplied by the guest view only: open a file without an authenticated route. */
  onOpenFile?: (node: NodeItem) => void
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
  const href =
    node.type === 'FOLDER' ? `/rooms/${roomId}/f/${node.id}` : `/rooms/${roomId}/file/${node.id}`
  // One of the two guest callbacks, or nothing at all. Resolved once so the name cell
  // and the menu's Open item can never disagree about where this row leads.
  const navigateFolder = actions.onNavigateFolder
  const openFile = actions.onOpenFile
  const inPlace =
    node.type === 'FOLDER' && navigateFolder
      ? () => navigateFolder(node.id)
      : node.type === 'FILE' && openFile
        ? () => openFile(node)
        : null

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

      {/*
        The name travels with the navigation because the API has no single-node read:
        the viewer would otherwise have nothing to put in its heading.
      */}
      {inPlace ? (
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm hover:text-accent"
          onClick={() => inPlace()}
        >
          {node.name}
        </button>
      ) : (
        <Link
          to={href}
          state={{ name: node.name }}
          className="min-w-0 flex-1 truncate text-sm hover:text-accent"
        >
          {node.name}
        </Link>
      )}

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
          <DropdownItem
            onSelect={() =>
              inPlace ? inPlace() : void navigate(href, { state: { name: node.name } })
            }
          >
            Open
          </DropdownItem>
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
