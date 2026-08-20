import { useCallback, useState } from 'react'
import { useParams } from 'react-router-dom'
import { AccessProvider } from '../access/AccessProvider'
import { AppShell } from '../components/AppShell'
import { ErrorState } from '../components/ErrorState'
import { Button } from '../components/ui/button'
import { OwnerOnly } from '../access/OwnerOnly'
import { BrowserToolbar } from './BrowserToolbar'
import { FileBrowser } from './FileBrowser'
import { NodeTable } from './NodeTable'
import { CreateFolderDialog } from './dialogs/CreateFolderDialog'
import { DeleteDialog } from './dialogs/DeleteDialog'
import { RenameDialog } from './dialogs/RenameDialog'
import { useNodeList, type NodeItem, type SortMode } from './hooks/useNodeList'

/** Stable identity: an inline arrow would re-render every memoized row on every keystroke. */
const noop = () => undefined

/**
 * The only place in the browser that fetches. Uploads, move and share are wired in by
 * Tasks 23–26; the handlers still on `noop` are the seams they plug into.
 */
export function RoomPage() {
  const { roomId = '', nodeId } = useParams()
  const [sort, setSort] = useState<SortMode>('name')
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)
  const [renaming, setRenaming] = useState<NodeItem | null>(null)
  const [deleting, setDeleting] = useState<NodeItem | null>(null)
  const list = useNodeList(roomId, nodeId ?? null, sort)

  const loadMore = useCallback(() => void list.fetchNextPage(), [list])
  const retry = useCallback(() => void list.refetch(), [list])
  const openCreateFolder = useCallback(() => setIsCreatingFolder(true), [])
  const closeCreateFolder = useCallback(() => setIsCreatingFolder(false), [])
  const closeRename = useCallback(() => setRenaming(null), [])
  const closeDelete = useCallback(() => setDeleting(null), [])

  if (list.isError) {
    return (
      <AppShell>
        <ErrorState error={list.error} onRetry={retry} />
      </AppShell>
    )
  }

  const first = list.data?.pages[0]
  const items: NodeItem[] = list.data?.pages.flatMap((page) => page.items) ?? []
  // The API names the folder it actually listed, which is the room root when the route
  // carried no node id. Creating a folder needs that id, so it waits for the response.
  const currentFolderId = first?.parent.id ?? nodeId ?? null

  return (
    <AccessProvider role={first?.role ?? 'OWNER'} scopeRootId={first?.scopeRootId ?? null}>
      <AppShell>
        <FileBrowser
          roomId={roomId}
          crumbs={first?.breadcrumbs ?? []}
          onDropOnCrumb={noop}
          toolbar={
            <BrowserToolbar
              sort={sort}
              onSortChange={setSort}
              onCreateFolder={openCreateFolder}
              onPickFiles={noop}
            />
          }
        >
          <NodeTable
            roomId={roomId}
            items={items}
            isLoading={list.isPending}
            hasMore={Boolean(list.hasNextPage)}
            onLoadMore={loadMore}
            onRename={setRenaming}
            onMove={noop}
            onDelete={setDeleting}
            onShare={noop}
            onDropOnFolder={noop}
            emptyAction={
              <OwnerOnly>
                <Button onClick={openCreateFolder}>New folder</Button>
              </OwnerOnly>
            }
          />
        </FileBrowser>

        {currentFolderId ? (
          <CreateFolderDialog
            roomId={roomId}
            parentId={currentFolderId}
            sort={sort}
            open={isCreatingFolder}
            onClose={closeCreateFolder}
          />
        ) : null}
        {renaming ? (
          <RenameDialog roomId={roomId} parentId={nodeId ?? null} sort={sort} node={renaming} onClose={closeRename} />
        ) : null}
        {deleting ? (
          <DeleteDialog roomId={roomId} parentId={nodeId ?? null} sort={sort} node={deleting} onClose={closeDelete} />
        ) : null}
      </AppShell>
    </AccessProvider>
  )
}
