import { Link2, Mail } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../components/ui/button'
import { formatRelativeDate } from '../lib/format'
import type { Share } from './hooks'

/**
 * The live grants on one item, in one mode. Revoked rows are filtered out rather than
 * struck through: the product has no undo, so a revoked grant is history, not state.
 */
export function ShareList({
  shares,
  mode,
  onRevoke,
  revoking,
}: {
  shares: Share[]
  mode: Share['mode']
  onRevoke: (shareId: string) => void
  revoking: boolean
}) {
  // Which row is asking for confirmation. Held here, not per row, so opening a second
  // question closes the first — two armed Revoke buttons is how the wrong one gets hit.
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const live = shares.filter((share) => share.mode === mode && !share.revokedAt)

  if (!live.length) {
    return (
      <p className="text-sm text-subtle">
        {mode === 'USER' ? 'Nobody has been invited yet.' : 'No active links.'}
      </p>
    )
  }

  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {live.map((share) => {
        const who = share.granteeEmail ?? 'the public link'
        const isConfirming = confirmingId === share.id
        return (
          <li key={share.id} className="flex items-center gap-2 px-3 py-2">
            {mode === 'USER' ? (
              <Mail size={14} className="shrink-0 text-subtle" />
            ) : (
              <Link2 size={14} className="shrink-0 text-subtle" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{share.granteeEmail ?? 'Anyone with the link'}</p>
              <p className="text-xs text-subtle">Viewer · added {formatRelativeDate(share.createdAt)}</p>
            </div>

            {isConfirming ? (
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-subtle">Revoke for good?</span>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={revoking}
                  aria-label={`Confirm revoking access for ${who}`}
                  onClick={() => {
                    setConfirmingId(null)
                    onRevoke(share.id)
                  }}
                >
                  Revoke
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Keep access for ${who}`}
                  onClick={() => setConfirmingId(null)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={revoking}
                aria-label={`Revoke access for ${who}`}
                onClick={() => setConfirmingId(share.id)}
              >
                Revoke
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
