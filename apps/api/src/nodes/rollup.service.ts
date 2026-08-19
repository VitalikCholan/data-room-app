import { Injectable } from '@nestjs/common'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { withinScope, type AccessContext } from '../access/access-context'
import { subtreeLikePattern } from './node-path'

export type Rollup = { folders: number; files: number; bytes: number }

@Injectable()
export class RollupService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One aggregate over the (roomId, path varchar_pattern_ops) index. No recursion and
   * no join: `sizeBytes` is denormalized onto Node from the current version precisely
   * so this query never touches FileVersion.
   *
   * `ctx` is optional because not every caller has a scoped one to give: an owner
   * listing every room they own (`RoomsService.listOwned`) and the plain
   * `/nodes/:id/rollup` endpoint both resolve `node` against the whole room, with no
   * narrower scope in play. When a caller does hold a scope-sensitive context —
   * `DeleteService.preview`, which pairs this total with a scope-checked share
   * count — passing it ANDs `withinScope(ctx)` onto the same query, so a scope
   * narrower than the room narrows what gets counted too.
   */
  async forSubtree(
    roomId: string,
    node: { id: string; path: string },
    ctx?: AccessContext,
  ): Promise<Rollup> {
    const [row] = await this.prisma.$queryRaw<
      { folders: bigint; files: bigint; bytes: bigint }[]
    >`
      SELECT count(*) FILTER (WHERE type = 'FOLDER')             AS folders,
             count(*) FILTER (WHERE type = 'FILE')               AS files,
             coalesce(sum("sizeBytes") FILTER (WHERE type = 'FILE'), 0) AS bytes
      FROM "Node"
      WHERE "roomId" = ${roomId}
        AND path LIKE ${subtreeLikePattern(node)}
        AND "deletedAt" IS NULL
        AND status = 'ACTIVE'
        AND ${ctx ? withinScope(ctx) : Prisma.sql`TRUE`}`
    return {
      folders: Number(row.folders),
      files: Number(row.files),
      bytes: Number(row.bytes),
    }
  }
}
