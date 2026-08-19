import { Prisma } from '../generated/prisma/client'

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

/**
 * The SQL predicate every scoped node read must AND onto its WHERE clause. Exists
 * because `scopePath` is `childPath(scopeRoot)` — the prefix matching everything
 * *strictly beneath* the scope root — so it never matches the scope root row itself.
 * A query that filters on `path LIKE scopePath || '%'` alone silently 404s a guest on
 * the very folder they were shared, because that folder's own row fails its own
 * child-prefix pattern. Exporting the combined check once means every later listing
 * or fetch writes `AND ${withinScope(ctx)}` and cannot drop the `id = scopeRootId`
 * half per call site.
 */
export const withinScope = (ctx: AccessContext) =>
  Prisma.sql`("id" = ${ctx.scopeRootId} OR path LIKE ${ctx.scopePath} || '%')`
