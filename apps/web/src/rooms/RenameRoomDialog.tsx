import { useState, type FormEvent } from 'react'
import { ApiError } from '../api/client'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { useRenameRoom, type Room } from './hooks'

export function RenameRoomDialog({ room, onClose }: { room: Room | null; onClose: () => void }) {
  const [name, setName] = useState(room?.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const rename = useRenameRoom()

  if (!room) return null
  // Captured as a const so the null-check above survives into the async closure.
  const roomId = room.id

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await rename.mutateAsync({ id: roomId, name: name.trim() })
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not rename')
    }
  }

  return (
    <Dialog open onOpenChange={onClose} title="Rename Data Room">
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="rename-room">
          Name
        </label>
        <Input
          id="rename-room"
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={rename.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
