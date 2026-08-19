export type AccessRole = 'OWNER' | 'VIEWER'

/**
 * Produced once per request. Every node read applies `scopePath` / `scopeRootId`,
 * so reading outside the granted subtree is impossible by construction rather than
 * by remembering a check.
 */
export type AccessContext = {
  role: AccessRole
  roomId: string
  /** Node the caller's access is rooted at: the room root for an owner, the shared node for a viewer. */
  scopeRootId: string
  /** childPath(scopeRoot) — the LIKE prefix matching everything strictly beneath the scope root. */
  scopePath: string
  userId?: string
  shareToken?: string
  viaShareId?: string
}

export const isOwner = (ctx: AccessContext) => ctx.role === 'OWNER'
