import { useCallback } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { AccessProvider } from '../access/AccessProvider'
import { AppShell } from '../components/AppShell'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'
import { VersionHistoryDrawer } from './VersionHistoryDrawer'
import { useDocumentObjectUrl, useRoomRole } from './hooks'

/** Passed by the row that linked here. Opening the url directly simply has no name yet. */
type ViewerNavigationState = { name?: string } | null

/**
 * Renders the PDF in the browser's own viewer, which brings zoom, search, print and
 * accessibility for free — react-pdf would add a worker bundle and hand-rolled
 * pagination for no requirement this product has.
 *
 * The version being read lives in the url rather than in state: `?version=` makes the
 * back button mean what a reader expects, and lets them hand somebody the exact version
 * they are looking at. Its absence means "whatever is current", which is the request the
 * content endpoint answers without a parameter.
 */
export function FileViewerPage() {
  const { roomId = '', nodeId = '' } = useParams()
  const state = useLocation().state as ViewerNavigationState
  const name = state?.name ?? 'Document'
  const [params, setParams] = useSearchParams()
  const version = params.get('version')
  const content = useDocumentObjectUrl(nodeId, version)
  const objectUrl = content.objectUrl
  // This page has no folder to list, so no response here carries a role. Ownership of the
  // room is the honest question instead — a share recipient reaches this very route from
  // "Shared with me".
  const role = useRoomRole(roomId)

  const selectVersion = useCallback(
    (versionId: string | null) => {
      // `replace` deliberately not used: stepping back through the versions a reader
      // looked at is the behaviour the url is here to give them.
      setParams(versionId ? { version: versionId } : {})
    },
    [setParams],
  )

  return (
    // Null while the ownership answer is in flight, and treated as a viewer until it
    // arrives: a restore control must never be rendered on a guess.
    <AccessProvider role={role ?? 'VIEWER'} scopeRootId={null}>
      <AppShell>
        <div className="mb-3 flex items-center gap-3">
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{name}</h1>
          <Link to={`/rooms/${roomId}`} className="text-sm text-accent hover:underline">
            Back to the Data Room
          </Link>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <div className="min-h-[70vh] overflow-hidden rounded-lg border border-border bg-surface">
            {content.isError ? (
              // 410 is the one every reader will eventually meet: the object behind this
              // version was overwritten or withdrawn, so there is nothing left to show.
              // It is reported as the state it is, not as a failed request to retry
              // forever. The header already carries the way out; a second copy of the
              // same link inside the message would just be two of the same thing.
              <ErrorState error={content.error} />
            ) : objectUrl ? (
              <iframe title={name} src={objectUrl} className="h-full min-h-[70vh] w-full" />
            ) : (
              <div className="p-4">
                <Skeleton className="h-[65vh] w-full" />
              </div>
            )}
          </div>

          <VersionHistoryDrawer
            nodeId={nodeId}
            roomId={roomId}
            selectedVersionId={version}
            onSelectVersion={selectVersion}
          />
        </div>
      </AppShell>
    </AccessProvider>
  )
}
