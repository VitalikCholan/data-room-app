import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Folder } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api/client'
import { queryKeys } from '../api/keys'
import { cn } from '../lib/cn'
import type { NodeListResponse } from './hooks/useNodeList'

/** One page is enough for a picker: 200 subfolders in one folder is already a design smell. */
const PICKER_LIMIT = 200

/**
 * Expands lazily, one folder per request. The node being moved renders disabled and
 * without an expander, so neither it nor anything beneath it can be selected — a cycle
 * is unreachable in the UI rather than selectable and then rejected by a 409.
 *
 * The component renders itself for each child; that is recursion, not a component
 * defined inside another component, so every level keeps a stable identity.
 */
export function FolderPicker({
  roomId,
  folderId,
  folderName,
  excludeId,
  selectedId,
  onSelect,
  depth = 0,
}: {
  roomId: string
  folderId: string
  folderName: string
  excludeId: string
  selectedId: string | null
  onSelect: (id: string) => void
  depth?: number
}) {
  const isExcluded = folderId === excludeId
  const [isExpanded, setIsExpanded] = useState(depth === 0)
  const children = useQuery({
    // Deliberately not `queryKeys.nodes.list`: that key belongs to the browser's
    // infinite query and holds a paged shape. Sharing it would hand this plain query
    // someone else's data. It still starts with `['nodes', roomId]`, so a move
    // invalidates the picker too.
    queryKey: queryKeys.nodes.folderChildren(roomId, folderId),
    enabled: isExpanded && !isExcluded,
    queryFn: () =>
      api.get<NodeListResponse>(
        `/rooms/${roomId}/nodes?parentId=${folderId}&sort=name&limit=${PICKER_LIMIT}`,
      ),
  })

  const subfolders = (children.data?.items ?? []).filter((item) => item.type === 'FOLDER')

  return (
    <div>
      <div className="flex items-center gap-1" style={{ paddingLeft: depth * 16 }}>
        {isExcluded ? (
          <span className="w-[22px]" aria-hidden="true" />
        ) : (
          <button
            type="button"
            aria-label={isExpanded ? `Collapse ${folderName}` : `Expand ${folderName}`}
            className="rounded p-0.5 text-subtle hover:bg-muted"
            onClick={() => setIsExpanded((previous) => !previous)}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
        <button
          type="button"
          disabled={isExcluded}
          onClick={() => onSelect(folderId)}
          className={cn(
            'flex flex-1 items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-40',
            selectedId === folderId && 'bg-accent/10 text-accent',
          )}
        >
          <Folder size={14} className="shrink-0" /> {folderName}
        </button>
      </div>

      {isExpanded && !isExcluded
        ? subfolders.map((folder) => (
            <FolderPicker
              key={folder.id}
              roomId={roomId}
              folderId={folder.id}
              folderName={folder.name}
              excludeId={excludeId}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))
        : null}
    </div>
  )
}
