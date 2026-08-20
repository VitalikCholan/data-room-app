import { useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { useCreateFolder } from '../hooks/useNodeMutations'
import type { SortMode } from '../hooks/useNodeList'
import { validateNodeName } from './validateNodeName'

export function CreateFolderDialog({
  roomId,
  parentId,
  sort,
  open,
  onClose,
}: {
  roomId: string
  parentId: string
  sort: SortMode
  open: boolean
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const create = useCreateFolder(roomId, parentId, sort)

  /** `autoFocus` alone loses to Radix, which focuses the close button on open. */
  function focusName(event: Event) {
    if (!inputRef.current) return
    event.preventDefault()
    inputRef.current.focus()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const problem = validateNodeName(name)
    if (problem) {
      setError(problem)
      return
    }
    try {
      await create.mutateAsync(name.trim())
      setName('')
      setError(null)
      onClose()
    } catch (err) {
      // A 409 here is the server telling the user the name is taken; it belongs
      // beside the field, not in a toast that outlives the dialog.
      setError(err instanceof ApiError ? err.message : 'Could not create the folder')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose} title="New folder" onOpenAutoFocus={focusName}>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="folder-name">
          Name
        </label>
        <Input
          id="folder-name"
          ref={inputRef}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="02 Financials"
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
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Create folder
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
