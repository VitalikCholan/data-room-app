import { FileText, Folder } from 'lucide-react'
import { memo, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { TableSkeleton } from '../components/Skeleton'
import { Button } from '../components/ui/button'
import { formatBytes, formatRelativeDate } from '../lib/format'
import { isSearchable, useSearch, type SearchHit } from './hooks'

/**
 * The guest's two callbacks, exactly as `NodeRow` takes them: every owner route sits
 * behind `RequireAuth`, so a link followed from a share would bounce to the sign-in page
 * — and would leave a url a reader could edit their way up from. Absent for the owner,
 * whose hits stay ordinary links.
 */
export type SearchNavigation = {
  onNavigateFolder?: (nodeId: string) => void
  onOpenFile?: (file: { id: string; name: string }) => void
}

export function SearchResults({
  roomId,
  term,
  scopeParentId,
  onClear,
  onNavigateFolder,
  onOpenFile,
}: {
  roomId: string
  term: string
  scopeParentId: string | null
  onClear: () => void
} & SearchNavigation) {
  const search = useSearch(roomId, term, scopeParentId)
  // One stable object for every row, so a memoized hit stays memoized.
  const navigation = useMemo<SearchNavigation>(
    () => ({ onNavigateFolder, onOpenFile }),
    [onNavigateFolder, onOpenFile],
  )
  const trimmed = term.trim()

  if (!isSearchable(trimmed)) {
    return <EmptyState title="Keep typing" hint="Enter at least two characters to search." />
  }
  if (search.isError)
    return <ErrorState error={search.error} onRetry={() => void search.refetch()} />
  if (!search.data) return <TableSkeleton rows={4} />
  if (search.data.items.length === 0) {
    return (
      <EmptyState
        title={`No matches for "${trimmed}"`}
        hint="Search looks at names only, not what is inside a document."
        action={<Button onClick={onClear}>Clear search</Button>}
      />
    )
  }

  return (
    <div
      className="divide-y divide-border"
      role="list"
      aria-label={`Search results for ${trimmed}`}
    >
      {search.data.items.map((hit) => (
        <SearchHitRow key={hit.id} roomId={roomId} hit={hit} navigation={navigation} />
      ))}
    </div>
  )
}

const SearchHitRow = memo(function SearchHitRow({
  roomId,
  hit,
  navigation,
}: {
  roomId: string
  hit: SearchHit
  navigation: SearchNavigation
}) {
  const href =
    hit.type === 'FOLDER' ? `/rooms/${roomId}/f/${hit.id}` : `/rooms/${roomId}/file/${hit.id}`
  const navigateFolder = navigation.onNavigateFolder
  const openFile = navigation.onOpenFile
  const inPlace =
    hit.type === 'FOLDER' && navigateFolder
      ? () => navigateFolder(hit.id)
      : hit.type === 'FILE' && openFile
        ? () => openFile({ id: hit.id, name: hit.name })
        : null

  return (
    <div role="listitem" className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/60">
      {hit.type === 'FOLDER' ? (
        <Folder size={16} className="shrink-0 text-accent" />
      ) : (
        <FileText size={16} className="shrink-0 text-subtle" />
      )}
      <div className="min-w-0 flex-1">
        {inPlace ? (
          <button
            type="button"
            className="block max-w-full truncate text-left text-sm hover:text-accent"
            onClick={inPlace}
          >
            {hit.name}
          </button>
        ) : (
          // The name travels with the navigation: the API has no single-node read, so the
          // viewer would otherwise have nothing to put in its heading.
          <Link
            to={href}
            state={{ name: hit.name }}
            className="block truncate text-sm hover:text-accent"
          >
            {hit.name}
          </Link>
        )}
        {/* Context matters in a result list: the same filename lives in many folders. */}
        <p className="truncate text-xs text-subtle">
          {hit.parentName ? `in ${hit.parentName}` : 'in this Data Room'}
        </p>
      </div>
      <span className="w-20 shrink-0 text-right text-xs text-subtle">
        {hit.type === 'FILE' && hit.sizeBytes !== null ? formatBytes(hit.sizeBytes) : '—'}
      </span>
      <span className="hidden w-28 shrink-0 text-right text-xs text-subtle sm:inline">
        {formatRelativeDate(hit.updatedAt)}
      </span>
    </div>
  )
})
