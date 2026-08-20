import { useQuery } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AccessProvider } from '../access/AccessProvider'
import { api } from '../api/client'
import { queryKeys } from '../api/keys'
import { useOptionalAuth } from '../auth/AuthProvider'
import { BrowserToolbar } from '../browser/BrowserToolbar'
import { FileBrowser } from '../browser/FileBrowser'
import { NodeTable } from '../browser/NodeTable'
import { useNodeList, type SortMode } from '../browser/hooks/useNodeList'
import { ErrorState } from '../components/ErrorState'
import { Skeleton, TableSkeleton } from '../components/Skeleton'
import { useDocumentObjectUrl } from '../files/hooks'
import { SearchInput } from '../search/SearchInput'
import { SearchResults } from '../search/SearchResults'
import { isSearchable, useDebounced } from '../search/hooks'
import { GuestGoneState } from './GuestGoneState'
import { useShareSession } from './shareSession'

type Bootstrap = {
  role: 'VIEWER'
  roomId: string
  roomName: string
  node: { id: string; name: string; type: 'FOLDER' | 'FILE' }
}

/** Stable identity, and the only implementation of a mutation a guest can reach. */
const noop = () => undefined

/**
 * The guest experience. The token is stored in the API client, then the ordinary browser
 * components take over: nothing below this component knows it is serving a guest, and the
 * role from the server is what hides every mutation control.
 *
 * There is no way up and no way out by construction, not by omission. The API truncates
 * the breadcrumbs at the caller's scope root, so the path above the shared node does not
 * exist in the response; navigation inside the share is in-place, so there is no url for
 * a curious reader to edit; and the toolbar is the owner's own, whose controls are all
 * behind `OwnerOnly` — a mutation control cannot appear here without also passing the
 * gate that hides it.
 */
export function GuestPage() {
  const { token = '' } = useParams()
  // First hook in the component: the share token must be in the client before any query
  // below it subscribes, or the first request would go out as nobody.
  useShareSession(token)
  const auth = useOptionalAuth()
  const [folderId, setFolderId] = useState<string | null>(null)
  // Only an id and a name are ever needed to view a document, and a search hit carries
  // no more than that.
  const [openFile, setOpenFile] = useState<{ id: string; name: string } | null>(null)
  const [sort, setSort] = useState<SortMode>('name')
  const [term, setTerm] = useState('')
  const debouncedTerm = useDebounced(term)

  const bootstrap = useQuery({
    queryKey: queryKeys.sharedBootstrap(token),
    queryFn: () => api.get<Bootstrap>(`/shared/${token}`),
    // A 404 or a 410 is the answer, not a failure: retrying a revoked link only delays
    // the sentence that explains it.
    retry: false,
    staleTime: Infinity,
  })

  const shared = bootstrap.data
  const targetId = folderId ?? shared?.node.id ?? null
  // Either the share itself is a file, or the guest opened one inside a shared folder.
  const viewing: { id: string; name: string } | null =
    openFile ?? (shared?.node.type === 'FILE' ? shared.node : null)
  const list = useNodeList(shared?.roomId ?? '', targetId, sort, {
    enabled: Boolean(shared) && !viewing && targetId !== null,
  })

  const closeFile = useCallback(() => setOpenFile(null), [])
  const loadMore = useCallback(() => void list.fetchNextPage(), [list])
  const clearSearch = useCallback(() => setTerm(''), [])

  if (bootstrap.isPending) return <TableSkeleton rows={4} />
  if (bootstrap.isError) return <GuestGoneState error={bootstrap.error} />
  // Any read failing mid-session is terminal for a guest: the owner revoked the link or
  // deleted the item, and there is nothing here to retry into existence.
  if (list.isError) return <GuestGoneState error={list.error} />
  if (!shared) return <GuestGoneState error={null} />

  const first = list.data?.pages[0]
  const items = list.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <AccessProvider role={shared.role} scopeRootId={shared.node.id}>
      <div className="min-h-screen">
        <header className="flex h-14 flex-wrap items-center gap-3 border-b border-border bg-surface px-4">
          <span className="text-sm font-semibold">Data Room</span>
          <span className="rounded bg-muted px-2 py-0.5 text-xs text-subtle">Shared with you · read-only</span>
          <span className="min-w-0 truncate text-sm text-subtle">{shared.roomName}</span>
          <div className="flex-1" />
          {/*
            The deliberate interaction when a signed-in owner opens their own link: the
            share token wins while this route is mounted, so they see exactly what they
            sent. Saying so is the difference between a useful preview and a bug report.
          */}
          {auth?.user ? (
            <div className="flex items-center gap-2 text-xs text-subtle">
              <span>
                Signed in as <span className="font-medium">{auth.user.email}</span> — this is what the recipient
                sees
              </span>
              <Link to="/" className="text-accent hover:underline">
                Leave the shared view
              </Link>
            </div>
          ) : null}
        </header>

        <main className="mx-auto w-full max-w-6xl px-4 py-6">
          {viewing ? (
            <GuestDocument nodeId={viewing.id} name={viewing.name} onBack={openFile ? closeFile : null} />
          ) : (
            <FileBrowser
              roomId={shared.roomId}
              crumbs={first?.breadcrumbs ?? []}
              onDropOnCrumb={noop}
              onNavigateCrumb={setFolderId}
              toolbar={
                <BrowserToolbar
                  sort={sort}
                  onSortChange={setSort}
                  onCreateFolder={noop}
                  onPickFiles={noop}
                  onShare={noop}
                >
                  <SearchInput value={term} onChange={setTerm} />
                </BrowserToolbar>
              }
            >
              {isSearchable(debouncedTerm) ? (
                <SearchResults
                  roomId={shared.roomId}
                  term={debouncedTerm}
                  /*
                    The shared node itself, always — never the folder the guest happens to
                    be standing in, and never null. The API resolves access from this id,
                    so it is what keeps a hit from outside the share from ever being named.
                  */
                  scopeParentId={shared.node.id}
                  onClear={clearSearch}
                  onNavigateFolder={setFolderId}
                  onOpenFile={setOpenFile}
                />
              ) : (
                <NodeTable
                  roomId={shared.roomId}
                  items={items}
                  isLoading={list.isPending}
                  hasMore={Boolean(list.hasNextPage)}
                  onLoadMore={loadMore}
                  onRename={noop}
                  onMove={noop}
                  onDelete={noop}
                  onShare={noop}
                  onDropOnFolder={noop}
                  onNavigateFolder={setFolderId}
                  onOpenFile={setOpenFile}
                />
              )}
            </FileBrowser>
          )}
        </main>
      </div>
    </AccessProvider>
  )
}

/**
 * The same bytes, through the same client, as the owner's viewer: an iframe pointed at
 * the content route directly would carry no share token and be refused. When the share
 * *is* the file there is nowhere to go back to, so a dead document is the whole screen.
 */
function GuestDocument({
  nodeId,
  name,
  onBack,
}: {
  nodeId: string
  name: string
  onBack: (() => void) | null
}) {
  const { objectUrl, isError, error } = useDocumentObjectUrl(nodeId)

  if (isError && !onBack) return <GuestGoneState error={error} />

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</h1>
        {onBack ? (
          <button type="button" className="text-sm text-accent hover:underline" onClick={onBack}>
            Back to folder
          </button>
        ) : null}
      </div>
      {isError ? (
        <ErrorState error={error} />
      ) : objectUrl ? (
        <iframe title={name} src={objectUrl} className="h-[75vh] w-full" />
      ) : (
        <div className="p-4">
          <Skeleton className="h-[70vh] w-full" />
        </div>
      )}
    </section>
  )
}
