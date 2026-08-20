import { memo, useCallback, useState } from 'react'
import { toast } from 'sonner'
import { OwnerOnly } from '../access/OwnerOnly'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { formatBytes, formatRelativeDate } from '../lib/format'
import { useRestoreVersion, useVersions, type FileVersion } from './hooks'

/**
 * The file's history beside the file. Reading an older version is a read, so a share
 * recipient keeps it; restoring one rewrites which bytes the file serves, so it sits
 * behind `OwnerOnly` and behind a question.
 */
export function VersionHistoryDrawer({
  nodeId,
  roomId,
  selectedVersionId,
  onSelectVersion,
}: {
  nodeId: string
  roomId: string
  /** Null means "whatever is current", which is what the plain content url serves. */
  selectedVersionId: string | null
  onSelectVersion: (versionId: string | null) => void
}) {
  const versions = useVersions(nodeId)
  const restore = useRestoreVersion(nodeId, roomId)
  const [confirming, setConfirming] = useState<FileVersion | null>(null)

  const closeConfirm = useCallback(() => setConfirming(null), [])
  const restoreVersion = restore.mutateAsync
  const confirmRestore = useCallback(() => {
    const version = confirming
    if (!version) return
    setConfirming(null)
    restoreVersion(version.id)
      .then(() => {
        // Back to the current version: the one just restored *is* current now, and the
        // `?version=` url for it would pin the reader to a copy of the same bytes.
        onSelectVersion(null)
        toast.success(`Version ${version.versionNo} is now the current version`)
      })
      .catch(() => toast.error('Could not restore that version'))
  }, [confirming, restoreVersion, onSelectVersion])

  return (
    <aside className="rounded-lg border border-border bg-surface" aria-label="Version history">
      <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Version history</h2>

      {versions.isError ? (
        <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
      ) : !versions.data ? (
        <div className="p-4">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <>
          {versions.data.length === 1 ? (
            <p className="px-4 pt-3 text-xs text-subtle">
              This is the only version — uploading this name again is how a second one appears.
            </p>
          ) : null}
          <ul className="divide-y divide-border">
            {versions.data.map((version) => (
              <VersionRow
                key={version.id}
                version={version}
                isViewing={
                  version.isCurrent ? selectedVersionId === null : selectedVersionId === version.id
                }
                isRestoring={restore.isPending}
                onSelect={onSelectVersion}
                onAskRestore={setConfirming}
              />
            ))}
          </ul>
        </>
      )}

      {confirming ? (
        <Dialog
          open
          onOpenChange={closeConfirm}
          title={`Restore version ${confirming.versionNo}?`}
          description={`Version ${confirming.versionNo} becomes the current version. Nothing is deleted — the version that is current now stays in this history.`}
          footer={
            <>
              <Button onClick={closeConfirm}>Cancel</Button>
              <Button variant="primary" onClick={confirmRestore}>
                Restore version {confirming.versionNo}
              </Button>
            </>
          }
        />
      ) : null}
    </aside>
  )
}

const VersionRow = memo(function VersionRow({
  version,
  isViewing,
  isRestoring,
  onSelect,
  onAskRestore,
}: {
  version: FileVersion
  isViewing: boolean
  isRestoring: boolean
  onSelect: (versionId: string | null) => void
  onAskRestore: (version: FileVersion) => void
}) {
  return (
    <li className="flex items-center gap-2 px-4 py-2.5">
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        aria-current={isViewing ? 'true' : undefined}
        // The current version is selected as null, never as its own id: that is the url
        // the content endpoint already answers without a parameter.
        onClick={() => onSelect(version.isCurrent ? null : version.id)}
      >
        <p className="text-sm">
          Version {version.versionNo}
          {version.isCurrent ? (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-subtle">Current</span>
          ) : null}
          {isViewing ? <span className="ml-2 text-xs text-accent">viewing</span> : null}
        </p>
        <p className="text-xs text-subtle">
          {formatBytes(version.sizeBytes)} · {formatRelativeDate(version.createdAt)}
        </p>
      </button>
      {version.isCurrent ? null : (
        <OwnerOnly>
          <Button size="sm" disabled={isRestoring} onClick={() => onAskRestore(version)}>
            Restore
          </Button>
        </OwnerOnly>
      )}
    </li>
  )
})
