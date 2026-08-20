import { FileText, Folder } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { SharedItem } from './hooks'

export function SharedWithMeList({ items }: { items: SharedItem[] }) {
  if (!items.length) return null
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-semibold">Shared with me</h2>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.shareId}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3"
          >
            {item.nodeType === 'FOLDER' ? (
              <Folder size={16} className="text-subtle" />
            ) : (
              <FileText size={16} className="text-subtle" />
            )}
            <div className="min-w-0 flex-1">
              <Link
                to={
                  item.nodeType === 'FOLDER'
                    ? `/rooms/${item.roomId}/f/${item.nodeId}`
                    : `/rooms/${item.roomId}/file/${item.nodeId}`
                }
                className="block truncate text-sm font-medium hover:text-accent"
              >
                {item.nodeName}
              </Link>
              <p className="text-xs text-subtle">
                {item.isWholeRoom ? 'Entire Data Room' : `in ${item.roomName}`} · read-only
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
