import { Injectable } from '@nestjs/common'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import type { AccessContext } from '../access/access-context'
import { withinScope } from '../access/access-context'
import type { NodeRow } from '../access/access.resolver'
import { ancestorIds, childPath } from './node-path'
import { decodeCursor, encodeCursor } from './cursor'

export type SortMode = 'name' | 'updatedAt' | 'size'
export type Crumb = { id: string; name: string; type: 'FOLDER' | 'FILE' }

/**
 * Every read here carries the caller's scope prefix. A query without it would be a
 * cross-room leak, so the scope is applied in the WHERE clause rather than filtered
 * after the fetch.
 */
@Injectable()
export class NodesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listChildren(
    ctx: AccessContext,
    parent: { id: string; path: string },
    opts: { cursor?: string; limit: number; sort: SortMode },
  ): Promise<{ items: NodeRow[]; nextCursor: string | null }> {
    // Folders before files is baked into the sort key so one keyset comparison
    // covers both the grouping and the ordering. The marker is the leading
    // character of the concatenated key, so under a DESC comparison a fixed
    // '0'/'1' marker would put files first (files' marker '1' > folders' '0').
    // Flipping the marker per direction keeps folders first regardless of mode.
    const sortExpr =
      opts.sort === 'name'
        ? Prisma.sql`lower(name)`
        : opts.sort === 'updatedAt'
          ? Prisma.sql`to_char("updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')`
          : Prisma.sql`lpad(coalesce("sizeBytes", 0)::text, 20, '0')`
    const descending = opts.sort !== 'name'
    const comparator = Prisma.raw(descending ? '<' : '>')
    const direction = Prisma.raw(descending ? 'DESC' : 'ASC')
    const folderMarker = Prisma.raw(descending ? "'1'" : "'0'")
    const fileMarker = Prisma.raw(descending ? "'0'" : "'1'")

    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
    const childPrefix = childPath(parent)

    const rows = await this.prisma.$queryRaw<
      (NodeRow & { sort_key: string })[]
    >`
      WITH scoped AS (
        SELECT *,
               (CASE WHEN type = 'FOLDER' THEN ${folderMarker} ELSE ${fileMarker} END || ${sortExpr}) AS sort_key
        FROM "Node"
        WHERE "roomId" = ${ctx.roomId}
          AND "parentId" = ${parent.id}
          AND path = ${childPrefix}
          AND ${withinScope(ctx)}
          AND "deletedAt" IS NULL
          AND status = 'ACTIVE'
      )
      SELECT * FROM scoped
      WHERE ${cursor ? Prisma.sql`(sort_key, id) ${comparator} (${cursor.key}, ${cursor.id})` : Prisma.sql`TRUE`}
      ORDER BY sort_key ${direction}, id ${direction}
      LIMIT ${opts.limit + 1}`

    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    const last = page[page.length - 1]
    return {
      items: page.map(({ sort_key, ...node }) => node),
      nextCursor:
        hasMore && last
          ? encodeCursor({ key: last.sort_key, id: last.id })
          : null,
    }
  }

  /**
   * The node's path already lists its ancestors, so this is one query with no
   * recursion. Ancestors above the caller's scope root are dropped, which is what
   * stops a guest from seeing — or clicking into — the rest of the Data Room.
   * The truncation happens on the id list derived from the already access-checked
   * node's own path, before any row is fetched, so no row belonging to another
   * subtree is ever read back, let alone filtered out afterward.
   */
  async breadcrumbs(
    ctx: AccessContext,
    node: { id: string; name: string; type: 'FOLDER' | 'FILE'; path: string },
  ): Promise<Crumb[]> {
    const ids = ancestorIds(node.path)
    const scopeIdx = ids.indexOf(ctx.scopeRootId)
    // `node` itself is only safe to disclose when it either *is* the scope root or
    // sits somewhere in the ancestor chain below it. Every real caller already passes
    // a guard-resolved (ctx, node) pair where this always holds, but nothing in the
    // type system enforces that — a mismatched pair (ctx scoped to one subtree, node
    // from another) must come back empty rather than silently leaking node's own
    // name/id/type as a trailing crumb.
    const inScope = node.id === ctx.scopeRootId || scopeIdx >= 0
    if (!inScope) return []
    const visible = scopeIdx >= 0 ? ids.slice(scopeIdx) : []

    const rows = visible.length
      ? await this.prisma.$queryRaw<Crumb[]>`
          SELECT id, name, type FROM "Node" WHERE id = ANY(${visible}::text[]) AND ${withinScope(ctx)}`
      : []

    const byId = new Map(rows.map((r) => [r.id, r]))
    const ordered = visible
      .map((id) => byId.get(id))
      .filter((c): c is Crumb => Boolean(c))
    return [...ordered, { id: node.id, name: node.name, type: node.type }]
  }

  /**
   * Names already used by live siblings, lower-cased to match the database index.
   * Takes `ctx` and applies `withinScope` even though `parentId` alone would already
   * be correct for every call site that exists today: nothing in the type system
   * stops a future caller (a move/copy flow, say) from passing a `parentId` it
   * resolved against a different scope than the one it authorized against, and this
   * is the only Node read in the file that would otherwise carry no scope check.
   */
  async takenSiblingNames(
    ctx: AccessContext,
    parentId: string,
  ): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
      SELECT name FROM "Node"
      WHERE "parentId" = ${parentId}
        AND ${withinScope(ctx)}
        AND "deletedAt" IS NULL`
    return new Set(rows.map((r) => r.name.toLowerCase()))
  }
}
