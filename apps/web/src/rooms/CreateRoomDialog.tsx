import { useState, type FormEvent } from 'react'
import { ApiError } from '../api/client'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { useCreateRoom } from './hooks'

export function CreateRoomDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useCreateRoom()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await create.mutateAsync(name.trim())
      setName('')
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the Data Room')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New Data Room"
      description="Everything inside stays private until you share it."
    >
      <form id="create-room" onSubmit={submit} className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="room-name">
          Name
        </label>
        <Input id="room-name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Project Titan" />
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
