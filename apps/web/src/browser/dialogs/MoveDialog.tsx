import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { FolderPicker } from '../FolderPicker'
import { useMoveNode } from '../hooks/useNodeMutations'
import { moveFailureMessage } from './moveFailureMessage'
import type { NodeItem, SortMode } from '../hooks/useNodeList'

export function MoveDialog({
  roomId,
  parentId,
  rootFolderId,
  sort,
  node,
  onClose,
}: {
  roomId: string
  parentId: string | null
  rootFolderId: string
  sort: SortMode
  node: NodeItem
  onClose: () => void
}) {
  const [targetId, setTargetId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const move = useMoveNode(roomId, parentId, sort)

  async function submit() {
    if (!targetId) return
    setError(null)
    try {
      await move.mutateAsync({ id: node.id, targetParentId: targetId })
      toast.success(`Moved "${node.name}"`)
      onClose()
    } catch (err) {
      setError(moveFailureMessage(err))
    }
  }

  return (
    <Dialog
      open
      onOpenChange={onClose}
      title={`Move "${node.name}"`}
      description="Pick a destination folder."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!targetId || move.isPending} onClick={() => void submit()}>
            {move.isPending ? 'Moving…' : 'Move here'}
          </Button>
        </>
      }
    >
      <div className="max-h-72 overflow-auto rounded-md border border-border p-2">
        <FolderPicker
          roomId={roomId}
          folderId={rootFolderId}
          folderName="Data Room root"
          excludeId={node.id}
          selectedId={targetId}
          onSelect={setTargetId}
        />
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Dialog>
  )
}
