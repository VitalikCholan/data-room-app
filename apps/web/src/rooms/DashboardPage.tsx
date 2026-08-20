import { useState } from 'react'
import { Plus } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { TableSkeleton } from '../components/Skeleton'
import { Button } from '../components/ui/button'
import { CreateRoomDialog } from './CreateRoomDialog'
import { DeleteRoomDialog } from './DeleteRoomDialog'
import { RenameRoomDialog } from './RenameRoomDialog'
import { RoomCard } from './RoomCard'
import { SharedWithMeList } from './SharedWithMeList'
import { useRooms, useSharedWithMe, type Room } from './hooks'

export function DashboardPage() {
  const rooms = useRooms()
  const shared = useSharedWithMe()
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<Room | null>(null)
  const [deleting, setDeleting] = useState<Room | null>(null)

  // The first-run empty state carries its own create button; showing the header
  // one too would present two identical actions on an otherwise empty page.
  const isEmpty = rooms.data?.length === 0

  return (
    <AppShell>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Data Rooms</h1>
        {!isEmpty ? (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New Data Room
          </Button>
        ) : null}
      </div>

      {rooms.isPending ? <TableSkeleton rows={3} /> : null}
      {rooms.isError ? (
        <ErrorState error={rooms.error} onRetry={() => void rooms.refetch()} />
      ) : null}

      {isEmpty ? (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState
            title="No Data Rooms yet"
            hint="A Data Room is the top-level container for a deal. Create one, then upload documents into folders."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={16} /> New Data Room
              </Button>
            }
          />
        </div>
      ) : null}

      {rooms.data && rooms.data.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rooms.data.map((room) => (
            <RoomCard
              key={room.id}
              room={room}
              onRename={() => setRenaming(room)}
              onDelete={() => setDeleting(room)}
            />
          ))}
        </ul>
      ) : null}

      {shared.data ? <SharedWithMeList items={shared.data} /> : null}

      <CreateRoomDialog open={creating} onOpenChange={setCreating} />
      {/* Keyed so each open remounts the dialog and the input prefills with the room's current name. */}
      <RenameRoomDialog
        key={renaming?.id ?? 'rename'}
        room={renaming}
        onClose={() => setRenaming(null)}
      />
      <DeleteRoomDialog room={deleting} onClose={() => setDeleting(null)} />
    </AppShell>
  )
}
