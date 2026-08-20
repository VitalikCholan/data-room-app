import { MoreHorizontal } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '../components/ui/button'
import {
  DropdownContent,
  DropdownItem,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
} from '../components/ui/dropdown-menu'
import { formatBytes, formatCount, formatRelativeDate } from '../lib/format'
import type { Room } from './hooks'

export function RoomCard({
  room,
  onRename,
  onDelete,
}: {
  room: Room
  onRename: () => void
  onDelete: () => void
}) {
  return (
    <li className="flex items-center gap-4 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="min-w-0 flex-1">
        <Link
          to={`/rooms/${room.id}`}
          className="block truncate text-sm font-medium hover:text-accent"
        >
          {room.name}
        </Link>
        <p className="mt-0.5 text-xs text-subtle">
          {formatCount(room.rollup.folders, 'folder')} · {formatCount(room.rollup.files, 'file')} ·{' '}
          {formatBytes(room.rollup.bytes)} · created {formatRelativeDate(room.createdAt)}
        </p>
      </div>
      <DropdownMenu>
        <DropdownTrigger asChild>
          <Button size="icon" variant="ghost" aria-label={`Actions for ${room.name}`}>
            <MoreHorizontal size={16} />
          </Button>
        </DropdownTrigger>
        <DropdownContent>
          <DropdownItem onSelect={onRename}>Rename</DropdownItem>
          <DropdownSeparator />
          <DropdownItem danger onSelect={onDelete}>
            Delete
          </DropdownItem>
        </DropdownContent>
      </DropdownMenu>
    </li>
  )
}
