import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AccessProvider } from '../access/AccessProvider'
import { queryKeys } from '../api/keys'
import { AppShell } from '../components/AppShell'
import { ErrorState } from '../components/ErrorState'
import { Button } from '../components/ui/button'
import { OwnerOnly } from '../access/OwnerOnly'
import { DropZoneOverlay } from '../uploads/DropZoneOverlay'
import { useUploadStore } from '../uploads/uploadStore'
import { BrowserToolbar } from './BrowserToolbar'
import { FileBrowser } from './FileBrowser'
import { NodeTable } from './NodeTable'
import { CreateFolderDialog } from './dialogs/CreateFolderDialog'
import { DeleteDialog } from './dialogs/DeleteDialog'
import { MoveDialog } from './dialogs/MoveDialog'
import { moveFailureMessage } from './dialogs/moveFailureMessage'
import { RenameDialog } from './dialogs/RenameDialog'
import { SearchInput } from '../search/SearchInput'
import { SearchResults } from '../search/SearchResults'
import { isSearchable, useDebounced } from '../search/hooks'
import { ShareDialog } from '../shares/ShareDialog'
import { useNodeList, type NodeItem, type SortMode } from './hooks/useNodeList'
import { useMoveNode } from './hooks/useNodeMutations'

/** The only place in the browser that fetches. */
export function RoomPage() {
  const { roomId = '', nodeId } = useParams()
  const [sort, setSort] = useState<SortMode>('name')
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)
  const [renaming, setRenaming] = useState<NodeItem | null>(null)
  const [deleting, setDeleting] = useState<NodeItem | null>(null)
  const [moving, setMoving] = useState<NodeItem | null>(null)
  const [sharing, setSharing] = useState<NodeItem | null>(null)
  const [isSharingFolder, setIsSharingFolder] = useState(false)
  const [term, setTerm] = useState('')
  // The request follows the typing by a quarter of a second, so the listing on screen is
  // never replaced by results for a term the user has already finished changing.
  const debouncedTerm = useDebounced(term)
  const list = useNodeList(roomId, nodeId ?? null, sort)
  const move = useMoveNode(roomId, nodeId ?? null, sort)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const enqueue = useUploadStore((state) => state.enqueue)
  const setOnUploaded = useUploadStore((state) => state.setOnUploaded)
  const queryClient = useQueryClient()

  const first = list.data?.pages[0]
  const items: NodeItem[] = list.data?.pages.flatMap((page) => page.items) ?? []
  // The API names the folder it actually listed, which is the room root when the route
  // carried no node id. Uploading and creating a folder need that real id, so both wait
  // for the response. It is a request parameter only, never a cache key: the listing is
  // keyed on the route's parent, which is null here (see `queryKeys.nodes.list`).
  const currentFolderId = first?.parent.id ?? nodeId ?? null

  const loadMore = useCallback(() => void list.fetchNextPage(), [list])
  const retry = useCallback(() => void list.refetch(), [list])
  const openCreateFolder = useCallback(() => setIsCreatingFolder(true), [])
  const closeCreateFolder = useCallback(() => setIsCreatingFolder(false), [])
  const closeRename = useCallback(() => setRenaming(null), [])
  const closeDelete = useCallback(() => setDeleting(null), [])
  const closeMove = useCallback(() => setMoving(null), [])
  const closeShare = useCallback(() => setSharing(null), [])
  const openShareFolder = useCallback(() => setIsSharingFolder(true), [])
  const clearSearch = useCallback(() => setTerm(''), [])
  const closeShareFolder = useCallback(() => setIsSharingFolder(false), [])

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

  const dropFiles = useCallback(
    (files: File[]) => {
      if (currentFolderId) void enqueue(files, roomId, currentFolderId)
    },
    [enqueue, roomId, currentFolderId],
  )
  const openFilePicker = useCallback(() => fileInputRef.current?.click(), [])
  const handlePickedFiles = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      dropFiles(Array.from(event.target.files ?? []))
      // Cleared so picking the same file twice in a row still fires a change event.
      event.target.value = ''
    },
    [dropFiles],
  )

  // Registered once rather than read from the store: the queue outlives this page, so
  // the refresh has to be a callback the store owns, not an effect that unmounts with
  // the folder the upload started in.
  useEffect(() => {
    setOnUploaded((task) => {
      // The room prefix, not `nodes.list(roomId, task.parentId, sort)`: an upload into
      // the room root carries the root node's real id, while the listing showing it is
      // keyed on the `'root'` sentinel — a per-folder key would match nothing and the
      // new file would stay invisible for the whole 15-second staleTime. The prefix also
      // covers whichever sort mode the listing happens to be on.
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodes.roomLists(task.roomId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms.all })
      // An upload answered with NEW_VERSION lands inside a file that already exists, so
      // its history is a version short and its cached bytes are the previous version's —
      // and those bytes are held for four minutes, long enough for a reader to open the
      // viewer and be shown the wrong document.
      if (task.nodeId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.nodes.versions(task.nodeId) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.nodes.contentAll(task.nodeId) })
      }
      // The user may have navigated away mid-upload; the toast is how they hear about it.
      if (task.parentId !== currentFolderId) toast.success(`"${task.name}" uploaded`)
    })
  }, [setOnUploaded, queryClient, currentFolderId])

  if (list.isError) {
    return (
      <AppShell>
        <ErrorState error={list.error} onRetry={retry} />
      </AppShell>
    )
  }

  // A live query answers the whole subtree the caller may see, so the folder listing has
  // nothing left to add while one is running: the results replace it rather than sit under
  // it. Below two characters nothing is searched and the listing simply stays.
  const searching = isSearchable(debouncedTerm)

  const browser = (
    <FileBrowser
      roomId={roomId}
      crumbs={first?.breadcrumbs ?? []}
      onDropOnCrumb={dropOnCrumb}
      toolbar={
        <BrowserToolbar
          sort={sort}
          onSortChange={setSort}
          onCreateFolder={openCreateFolder}
          onPickFiles={openFilePicker}
          onShare={openShareFolder}
        >
          <SearchInput value={term} onChange={setTerm} />
        </BrowserToolbar>
      }
    >
      {searching ? (
        <SearchResults
          roomId={roomId}
          term={debouncedTerm}
          // Null for an owner, so the API resolves access from the room and the whole tree
          // answers. A VIEWER's search is pinned to the node they were given, which is
          // what stops a hit from outside their share ever being named to them.
          scopeParentId={first?.role === 'VIEWER' ? first.scopeRootId : null}
          onClear={clearSearch}
        />
      ) : (
        <NodeTable
          roomId={roomId}
          items={items}
          isLoading={list.isPending}
          hasMore={Boolean(list.hasNextPage)}
          onLoadMore={loadMore}
          onRename={setRenaming}
          onMove={setMoving}
          onDelete={setDeleting}
          onShare={setSharing}
          onDropOnFolder={dropOnFolder}
          emptyAction={
            <OwnerOnly>
              <Button onClick={openCreateFolder}>New folder</Button>
            </OwnerOnly>
          }
        />
      )}
    </FileBrowser>
  )

  return (
    <AccessProvider role={first?.role ?? 'OWNER'} scopeRootId={first?.scopeRootId ?? null}>
      <AppShell>
        {/*
          A viewer gets the same listing with no drop target and no file input at all.
          OwnerOnly stays the single place that asks the question — here as a wrapper
          rather than a gate, because the listing itself is for everyone.
        */}
        <OwnerOnly fallback={browser}>
          <DropZoneOverlay onFiles={dropFiles}>{browser}</DropZoneOverlay>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="application/pdf"
            className="hidden"
            onChange={handlePickedFiles}
          />
        </OwnerOnly>

        {currentFolderId ? (
          <CreateFolderDialog
            roomId={roomId}
            parentId={currentFolderId}
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
        {/*
          Two ways in, one dialog: a row's own menu, and the toolbar for the folder on
          screen. The toolbar's copy says "this Data Room" when that folder is the room
          root, because that is what sharing it actually hands over.
        */}
        {sharing ? (
          <ShareDialog
            nodeId={sharing.id}
            nodeName={sharing.name}
            nodeType={sharing.type}
            onClose={closeShare}
          />
        ) : null}
        {isSharingFolder && first ? (
          <ShareDialog
            nodeId={first.parent.id}
            nodeName={first.parent.name}
            nodeType="FOLDER"
            isWholeRoom={first.parent.id === first.scopeRootId && !nodeId}
            onClose={closeShareFolder}
          />
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
