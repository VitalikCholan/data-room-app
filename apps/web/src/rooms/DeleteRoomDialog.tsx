import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { formatBytes, formatCount } from '../lib/format'
import { useDeleteRoom, type Room } from './hooks'

export function DeleteRoomDialog({ room, onClose }: { room: Room | null; onClose: () => void }) {
  const remove = useDeleteRoom()
  if (!room) return null

  return (
    <Dialog
      open
      onOpenChange={onClose}
      title={`Delete "${room.name}"?`}
      description="This cannot be undone. Anyone you shared this Data Room with immediately loses access."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={async () => {
              await remove.mutateAsync(room.id)
              toast.success(`"${room.name}" deleted`)
              onClose()
            }}
          >
            {remove.isPending ? 'Deleting…' : 'Delete Data Room'}
          </Button>
        </>
      }
    >
      <ul className="rounded-md bg-muted px-4 py-3 text-sm text-subtle">
        <li>{formatCount(room.rollup.folders, 'folder')}</li>
        <li>{formatCount(room.rollup.files, 'file')}</li>
        <li>{formatBytes(room.rollup.bytes)} of documents</li>
      </ul>
    </Dialog>
  )
}
