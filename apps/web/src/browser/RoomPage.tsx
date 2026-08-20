import { useCallback, useState } from 'react'
import { useParams } from 'react-router-dom'
import { AccessProvider } from '../access/AccessProvider'
import { AppShell } from '../components/AppShell'
import { ErrorState } from '../components/ErrorState'
import { BrowserToolbar } from './BrowserToolbar'
import { FileBrowser } from './FileBrowser'
import { NodeTable } from './NodeTable'
import { useNodeList, type NodeItem, type SortMode } from './hooks/useNodeList'

/** Stable identity: an inline arrow would re-render every memoized row on every keystroke. */
const noop = () => undefined

/**
 * The only place in the browser that fetches. Dialogs and the upload queue are wired
 * in by Tasks 22–24; the handlers below are the seams they plug into.
 */
export function RoomPage() {
  const { roomId = '', nodeId } = useParams()
  const [sort, setSort] = useState<SortMode>('name')
  const list = useNodeList(roomId, nodeId ?? null, sort)

  const loadMore = useCallback(() => void list.fetchNextPage(), [list])
  const retry = useCallback(() => void list.refetch(), [list])

  if (list.isError) {
    return (
      <AppShell>
        <ErrorState error={list.error} onRetry={retry} />
      </AppShell>
    )
  }

  const first = list.data?.pages[0]
  const items: NodeItem[] = list.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <AccessProvider role={first?.role ?? 'OWNER'} scopeRootId={first?.scopeRootId ?? null}>
      <AppShell>
        <FileBrowser
          roomId={roomId}
          crumbs={first?.breadcrumbs ?? []}
          onDropOnCrumb={noop}
          toolbar={
            <BrowserToolbar sort={sort} onSortChange={setSort} onCreateFolder={noop} onPickFiles={noop} />
          }
        >
          <NodeTable
            roomId={roomId}
            items={items}
            isLoading={list.isPending}
            hasMore={Boolean(list.hasNextPage)}
            onLoadMore={loadMore}
            onRename={noop}
            onMove={noop}
            onDelete={noop}
            onShare={noop}
            onDropOnFolder={noop}
          />
        </FileBrowser>
      </AppShell>
    </AccessProvider>
  )
}
