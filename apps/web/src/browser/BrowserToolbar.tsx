import { FolderPlus, Share2, Upload } from 'lucide-react'
import type { ReactNode } from 'react'
import { OwnerOnly } from '../access/OwnerOnly'
import { Button } from '../components/ui/button'
import type { SortMode } from './hooks/useNodeList'

export function BrowserToolbar({
  sort,
  onSortChange,
  onCreateFolder,
  onPickFiles,
  onShare,
  children,
}: {
  sort: SortMode
  onSortChange: (sort: SortMode) => void
  onCreateFolder: () => void
  onPickFiles: () => void
  /** Shares the folder currently on screen, which is the only one this toolbar knows. */
  onShare: () => void
  children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
      {children}
      <div className="flex-1" />
      <label className="sr-only" htmlFor="sort">
        Sort by
      </label>
      <select
        id="sort"
        value={sort}
        onChange={(event) => onSortChange(event.target.value as SortMode)}
        className="h-8 rounded-md border border-border bg-surface px-2 text-sm"
      >
        <option value="name">Name</option>
        <option value="updatedAt">Last modified</option>
        <option value="size">Size</option>
      </select>
      <OwnerOnly>
        <Button size="sm" onClick={onShare}>
          <Share2 size={16} /> Share
        </Button>
        <Button size="sm" onClick={onCreateFolder}>
          <FolderPlus size={16} /> New folder
        </Button>
        <Button size="sm" variant="primary" onClick={onPickFiles}>
          <Upload size={16} /> Upload
        </Button>
      </OwnerOnly>
    </div>
  )
}
