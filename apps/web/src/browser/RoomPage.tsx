import { useCallback, useState } from 'react'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
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
import { MoveDialog } from './dialogs/MoveDialog'
import { moveFailureMessage } from './dialogs/moveFailureMessage'
import { RenameDialog } from './dialogs/RenameDialog'
import { useNodeList, type NodeItem, type SortMode } from './hooks/useNodeList'
import { useMoveNode } from './hooks/useNodeMutations'

/** Stable identity: an inline arrow would re-render every memoized row on every keystroke. */
const noop = () => undefined

/**
 * The only place in the browser that fetches. Uploads and share are wired in by
 * Tasks 24 and 26; the handlers still on `noop` are the seams they plug into.
 */
export function RoomPage() {
  const { roomId = '', nodeId } = useParams()
  const [sort, setSort] = useState<SortMode>('name')
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)
  const [renaming, setRenaming] = useState<NodeItem | null>(null)
  const [deleting, setDeleting] = useState<NodeItem | null>(null)
  const [moving, setMoving] = useState<NodeItem | null>(null)
  const list = useNodeList(roomId, nodeId ?? null, sort)
  const move = useMoveNode(roomId, nodeId ?? null, sort)

  const loadMore = useCallback(() => void list.fetchNextPage(), [list])
  const retry = useCallback(() => void list.refetch(), [list])
  const openCreateFolder = useCallback(() => setIsCreatingFolder(true), [])
  const closeCreateFolder = useCallback(() => setIsCreatingFolder(false), [])
  const closeRename = useCallback(() => setRenaming(null), [])
  const closeDelete = useCallback(() => setDeleting(null), [])
  const closeMove = useCallback(() => setMoving(null), [])

  // `mutateAsync` is a stable reference, so both handlers below keep their identity and
  // the memoized rows are not re-rendered by a mutation's own state changes.
  const moveInto = move.mutateAsync
  const dropOnFolder = useCallback(
    (sourceId: string, targetFolderId: string) => {
      // The row already ruled out a self-drop; a 409 here is a real name clash or a
      // cycle through a folder the row could not see.
      moveInto({ id: sourceId, targetParentId: targetFolderId })
        .then(() => toast.success('Moved'))
        .catch((error: unknown) => toast.error(moveFailureMessage(error)))
    },
    [moveInto],
  )
  const dropOnCrumb = useCallback(
    (folderId: string, sourceId: string) => dropOnFolder(sourceId, folderId),
    [dropOnFolder],
  )

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
          onDropOnCrumb={dropOnCrumb}
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
            onMove={setMoving}
            onDelete={setDeleting}
            onShare={noop}
            onDropOnFolder={dropOnFolder}
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
        {/* The picker starts at the caller's scope root, which the listing reports. */}
        {moving && first ? (
          <MoveDialog
            roomId={roomId}
            parentId={nodeId ?? null}
            rootFolderId={first.scopeRootId}
            sort={sort}
            node={moving}
            onClose={closeMove}
          />
        ) : null}
      </AppShell>
    </AccessProvider>
  )
}
