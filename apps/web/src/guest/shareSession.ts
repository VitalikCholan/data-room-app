import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { setShareToken } from '../api/client'
import { queryKeys } from '../api/keys'

/**
 * The one writer of the API client's share token, and the answer to a real hazard.
 *
 * `send()` gives the share token precedence over the bearer — it must, because a guest
 * is identified by the token alone and a stale bearer would make the API resolve the
 * wrong identity. The cost of that precedence is that setting the token changes *who
 * the whole client is*: a signed-in owner who opens a share link would otherwise stay a
 * guest for every request they made afterwards, in every tab-life of the app, with no
 * way back short of a reload.
 *
 * So the token's lifetime is exactly the lifetime of the share route, and leaving it
 * also evicts every node-scoped cache entry. Invalidation would be wrong here: those
 * entries are not stale, they are *somebody else's* — the guest's scoped listings must
 * not be handed to the owner, nor the owner's to the guest, and the two collide on the
 * same query keys because they are the same screens.
 *
 * The deliberate interaction for a signed-in owner opening their own link: the share
 * wins while the route is mounted, so they see precisely what the recipient sees, which
 * is the only way to check a link before sending it. `GuestPage` says so on screen and
 * offers the way out; leaving restores their own identity.
 */
export function useShareSession(token: string) {
  const client = useQueryClient()

  useEffect(() => {
    setShareToken(token)
    return () => {
      setShareToken(null)
      client.removeQueries({ queryKey: queryKeys.nodes.all })
      // Search answers are node reads too, and a guest's are scoped to their share: the
      // owner must never be handed one back, nor the guest one of the owner's.
      client.removeQueries({ queryKey: queryKeys.search.all })
    }
  }, [token, client])
}
