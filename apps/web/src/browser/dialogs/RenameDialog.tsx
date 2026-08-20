import { useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { useRenameNode } from '../hooks/useNodeMutations'
import type { NodeItem, SortMode } from '../hooks/useNodeList'
import { validateNodeName } from './validateNodeName'

export function RenameDialog({
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
  const [name, setName] = useState(node.name)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rename = useRenameNode(roomId, parentId, sort)

  /**
   * Select the stem only — nobody wants to retype ".pdf". Done on the dialog's own
   * open-autofocus event rather than in an effect: the field mounts in a later commit
   * than this component's effects, so an effect would find `inputRef.current` null.
   */
  function selectStem(event: Event) {
    const input = inputRef.current
    if (!input) return
    event.preventDefault()
    const dot = node.name.lastIndexOf('.')
    input.focus()
    input.setSelectionRange(0, dot > 0 ? dot : node.name.length)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const problem = validateNodeName(name)
    if (problem) {
      setError(problem)
      return
    }
    if (name.trim() === node.name) {
      onClose()
      return
    }
    try {
      await rename.mutateAsync({ id: node.id, name: name.trim() })
      onClose()
    } catch (err) {
      // 409 means the name is taken in this folder: keep the dialog open with the
      // typed name intact so the fix is one edit away.
      setError(err instanceof ApiError ? err.message : 'Could not rename')
    }
  }

  return (
    <Dialog
      open
      onOpenChange={onClose}
      title={node.type === 'FOLDER' ? 'Rename folder' : 'Rename file'}
      onOpenAutoFocus={selectStem}
    >
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="rename-node">
          Name
        </label>
        <Input id="rename-node" ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} />
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
