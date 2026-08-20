import { Injectable } from '@nestjs/common'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import type { AccessContext } from '../access/access-context'
import { withinScope } from '../access/access-context'
import { decodeCursor, encodeCursor } from '../nodes/cursor'

export type SearchHit = {
  id: string
  name: string
  type: 'FOLDER' | 'FILE'
  sizeBytes: bigint | null
  updatedAt: Date
  parentId: string | null
  parentName: string | null
}

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Uses the `node_name_trgm` GIN index on name (pg_trgm supports ILIKE against a
   * `%needle%` pattern). Three properties are load-bearing:
   *
   *  - Scope is applied **in SQL**, through the same `withinScope(ctx)` predicate every
   *    other node read uses, so a share viewer's search cannot reach outside the
   *    subtree that was shared with them. Filtering after the fetch would still have
   *    read the rows, and `LIMIT` would have been spent on rows the caller may not see.
   *  - The keyset predicate is part of the query rather than a post-filter, so `LIMIT`
   *    stays honest and a page is never silently short.
   *  - The parent's name comes from a correlated subquery rather than a join, so the
   *    unqualified column references inside `withinScope` stay unambiguous — a second
   *    `"Node"` in the FROM list would make `id`/`path` ambiguous and the statement
   *    would not even parse.
   */
  async byName(
    ctx: AccessContext,
    q: string,
    opts: { cursor?: string; limit: number },
  ) {
    // LIKE metacharacters are escaped so a query of "20%" matches the literal string
    // instead of "anything containing 20". Backslash is ILIKE's default escape char.
    const needle = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null

    const rows = await this.prisma.$queryRaw<
      (SearchHit & { sort_key: string })[]
    >`
      WITH scoped AS (
        SELECT n.id, n.name, n.type, n."sizeBytes", n."updatedAt", n."parentId",
               (SELECT p.name FROM "Node" p WHERE p.id = n."parentId") AS "parentName",
               lower(n.name) AS sort_key
        FROM "Node" n
        WHERE n."roomId" = ${ctx.roomId}
          AND ${withinScope(ctx)}
          -- Matching the folder you are already inside is noise, not a hit.
          AND n.id <> ${ctx.scopeRootId}
          AND n."deletedAt" IS NULL
          AND n.status = 'ACTIVE'
          AND n.name ILIKE ${needle}
      )
      SELECT * FROM scoped
      WHERE ${cursor ? Prisma.sql`(sort_key, id) > (${cursor.key}, ${cursor.id})` : Prisma.sql`TRUE`}
      ORDER BY sort_key ASC, id ASC
      LIMIT ${opts.limit + 1}`

    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    const last = page[page.length - 1]

    return {
      items: page.map(({ sort_key, ...hit }) => hit),
      nextCursor:
        hasMore && last
          ? encodeCursor({ key: last.sort_key, id: last.id })
          : null,
    }
  }
}
