import { toast } from 'sonner'
import { ApiError } from '../../api/client'
import { Skeleton } from '../../components/Skeleton'
import { messageForError } from '../../components/ErrorState'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { formatBytes, formatCount } from '../../lib/format'
import { useDeleteNode, useDeletionPreview, type DeletionPreview } from '../hooks/useNodeMutations'
import type { NodeItem, SortMode } from '../hooks/useNodeList'

/**
 * Presentational: the warning is a statement of fact from the server, so it renders
 * nothing it has not been told.
 */
function DeletionSummary({ node, preview }: { node: NodeItem; preview: DeletionPreview }) {
  return (
    <div className="rounded-md bg-muted px-4 py-3 text-sm text-subtle">
      {node.type === 'FOLDER' ? (
        <ul>
          <li>{formatCount(preview.folders, 'folder')}</li>
          <li>{formatCount(preview.files, 'file')}</li>
          <li>{formatBytes(preview.bytes)} of documents</li>
        </ul>
      ) : (
        <p>{formatBytes(preview.bytes)} · all versions</p>
      )}
      {preview.activeShares > 0 ? (
        <p className="mt-2 font-medium text-danger">
          {formatCount(preview.activeShares, 'active share')} stop working — {preview.activeShares}{' '}
          people lose access.
        </p>
      ) : null}
    </div>
  )
}

export function DeleteDialog({
  roomId,
  parentId,
  sort,
  node,
  onClose,
}: {
  roomId: string
  parentId: string | null
  sort: SortMode
  node: NodeItem
  onClose: () => void
}) {
  const preview = useDeletionPreview(node.id)
  const remove = useDeleteNode(roomId, parentId, sort)

  async function confirm() {
    try {
      await remove.mutateAsync(node.id)
      toast.success(`"${node.name}" deleted`)
      onClose()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete')
    }
  }

  return (
    <Dialog
      open
      onOpenChange={onClose}
      title={`Delete "${node.name}"?`}
      description="This cannot be undone."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {/* Disabled until the preview lands: consent without the numbers is not consent. */}
          <Button
            variant="danger"
            disabled={!preview.data || remove.isPending}
            onClick={() => void confirm()}
          >
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </>
      }
    >
      {preview.isPending ? <Skeleton className="h-16 w-full" /> : null}
      {preview.data ? <DeletionSummary node={node} preview={preview.data} /> : null}
      {preview.isError ? (
        <div className="rounded-md bg-muted px-4 py-3 text-sm">
          <p className="text-danger">{messageForError(preview.error).hint}</p>
          <Button size="sm" className="mt-2" onClick={() => void preview.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}
    </Dialog>
  )
}
