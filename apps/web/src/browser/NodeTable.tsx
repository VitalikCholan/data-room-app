import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useMemo, useRef, type ReactNode } from 'react'
import { TableSkeleton } from '../components/Skeleton'
import { Button } from '../components/ui/button'
import { NodeRow, type NodeRowActions } from './NodeRow'
import { NodeTableEmpty } from './NodeTableEmpty'
import type { NodeItem } from './hooks/useNodeList'

const VIRTUALIZE_ABOVE = 200
const ROW_HEIGHT = 45

export function NodeTable({
  roomId,
  items,
  isLoading,
  hasMore,
  onLoadMore,
  emptyAction,
  onRename,
  onMove,
  onDelete,
  onShare,
  onDropOnFolder,
  onNavigateFolder,
  onOpenFile,
}: {
  roomId: string
  items: NodeItem[]
  isLoading: boolean
  hasMore: boolean
  onLoadMore: () => void
  emptyAction?: ReactNode
} & NodeRowActions) {
  // One stable object for every row, so a memoized NodeRow actually stays memoized.
  const actions = useMemo<NodeRowActions>(
    () => ({ onRename, onMove, onDelete, onShare, onDropOnFolder, onNavigateFolder, onOpenFile }),
    [onRename, onMove, onDelete, onShare, onDropOnFolder, onNavigateFolder, onOpenFile],
  )

  if (isLoading && items.length === 0) return <TableSkeleton rows={6} />
  if (items.length === 0) return <NodeTableEmpty action={emptyAction} />

  return (
    <div>
      {/* Below the threshold, plain rows keep the DOM simple and the a11y tree intact. */}
      {items.length <= VIRTUALIZE_ABOVE ? (
        <PlainRows roomId={roomId} items={items} actions={actions} />
      ) : (
        <VirtualRows roomId={roomId} items={items} actions={actions} />
      )}
      {hasMore ? <LoadMore onLoadMore={onLoadMore} /> : null}
    </div>
  )
}

const PlainRows = memo(function PlainRows({
  roomId,
  items,
  actions,
}: {
  roomId: string
  items: NodeItem[]
  actions: NodeRowActions
}) {
  return (
    <>
      {items.map((node) => (
        <NodeRow key={node.id} roomId={roomId} node={node} actions={actions} />
      ))}
    </>
  )
})

/**
 * Kept in its own component so the virtualizer is never constructed for a listing that
 * renders a skeleton, an empty state, or a short page of plain rows.
 */
const VirtualRows = memo(function VirtualRows({
  roomId,
  items,
  actions,
}: {
  roomId: string
  items: NodeItem[]
  actions: NodeRowActions
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  return (
    <div ref={scrollRef} className="max-h-[65vh] overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={items[virtualRow.index].id}
            style={{ position: 'absolute', top: virtualRow.start, left: 0, right: 0 }}
          >
            <NodeRow roomId={roomId} node={items[virtualRow.index]} actions={actions} />
          </div>
        ))}
      </div>
    </div>
  )
})

const LoadMore = ({ onLoadMore }: { onLoadMore: () => void }) => (
  <div className="flex justify-center border-t border-border py-3">
    <Button onClick={onLoadMore}>Load more</Button>
  </div>
)
