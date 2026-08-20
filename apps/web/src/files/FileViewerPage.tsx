import { Link, useLocation, useParams } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'
import { useDocumentObjectUrl } from './hooks'

/** Passed by the row that linked here. Opening the url directly simply has no name yet. */
type ViewerNavigationState = { name?: string } | null

/**
 * Renders the PDF in the browser's own viewer, which brings zoom, search, print and
 * accessibility for free — react-pdf would add a worker bundle and hand-rolled
 * pagination for no requirement this product has.
 *
 * There is no version history here on purpose: the API exposes no version endpoints
 * (Ruling 32), so a panel would be a promise the server cannot keep.
 */
export function FileViewerPage() {
  const { roomId = '', nodeId = '' } = useParams()
  const state = useLocation().state as ViewerNavigationState
  const name = state?.name ?? 'Document'
  const content = useDocumentObjectUrl(nodeId)
  const objectUrl = content.objectUrl

  const backToRoom = (
    <Link to={`/rooms/${roomId}`} className="text-sm text-accent hover:underline">
      Back to the Data Room
    </Link>
  )

  return (
    <AppShell>
      <div className="mb-3 flex items-center gap-3">
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{name}</h1>
        {backToRoom}
      </div>

      <div className="min-h-[70vh] overflow-hidden rounded-lg border border-border bg-surface">
        {content.isError ? (
          // 410 is the one every reader will eventually meet: the object behind this
          // file was overwritten or withdrawn, so there is nothing left to show. It is
          // reported as the state it is, not as a failed request to retry forever.
          // The header already carries the way out; a second copy of the same link
          // inside the message would just be two of the same thing.
          <ErrorState error={content.error} />
        ) : objectUrl ? (
          <iframe title={name} src={objectUrl} className="h-full min-h-[70vh] w-full" />
        ) : (
          <div className="p-4">
            <Skeleton className="h-[65vh] w-full" />
          </div>
        )}
      </div>
    </AppShell>
  )
}
