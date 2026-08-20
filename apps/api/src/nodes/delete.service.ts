import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { withinScope } from '../access/access-context'
import type { AccessContext } from '../access/access-context'
import type { NodeRow } from '../access/access.resolver'
import { DomainError } from '../common/errors'
import { subtreeLikePattern } from './node-path'
import { RollupService } from './rollup.service'

@Injectable()
export class DeleteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rollup: RollupService,
  ) {}

  /** Powers the confirmation dialog: what disappears, and who loses access. */
  async preview(ctx: AccessContext, node: NodeRow) {
    const totals = await this.rollup.forSubtree(ctx.roomId, node, ctx)
    // The scope check runs inside the subquery, not spliced onto the outer join:
    // `withinScope` emits a bare `"id"` / `path`, and the outer query already joins
    // Share (which has its own `id` column) onto Node — a bare `"id"` there would be
    // ambiguous. Scoping the Node lookup by itself, then matching Share.nodeId
    // against it, keeps `withinScope`'s contract (a single unaliased Node table)
    // intact instead of special-casing the helper for one join.
    const [row] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count
      FROM "Share" s
      WHERE s."revokedAt" IS NULL
        AND s."nodeId" IN (
          SELECT id FROM "Node"
          WHERE "roomId" = ${ctx.roomId}
            AND ${withinScope(ctx)}
            AND (id = ${node.id} OR path LIKE ${subtreeLikePattern(node)})
        )`
    return {
      folders: node.type === 'FOLDER' ? totals.folders : 0,
      files: node.type === 'FILE' ? 1 : totals.files,
      bytes: node.type === 'FILE' ? Number(node.sizeBytes ?? 0) : totals.bytes,
      activeShares: Number(row.count),
    }
  }

  /**
   * The tombstone is applied to every descendant, not only the subtree root. Marking
   * just the root would leave children visible to name search, which queries by
   * `deletedAt IS NULL` on the row itself.
   *
   * Blobs stay in the bucket; the hourly sweep is what removes them.
   */
  async remove(ctx: AccessContext, node: NodeRow) {
    if (node.id === ctx.scopeRootId) {
      throw new DomainError(
        'INVALID_TARGET',
        'Delete the Data Room itself to remove its root folder',
      )
    }
    const deletedAt = new Date()
    return this.prisma.$transaction(async (tx) => {
      const descendants = await tx.$executeRaw`
        UPDATE "Node" SET "deletedAt" = ${deletedAt}
        WHERE "roomId" = ${ctx.roomId} AND path LIKE ${subtreeLikePattern(node)} AND ${withinScope(ctx)} AND "deletedAt" IS NULL`
      // Scoped by roomId and withinScope, not only id: `node` here always arrives
      // pre-authorized via AccessGuard on every real route, but nothing in the type
      // system enforces that. Without these conditions a (ctx, node) pair assembled by
      // a future caller — from two different rooms, or from the same room but a
      // subtree outside ctx's grant — would still tombstone this one row even though
      // the descendants UPDATE above — correctly scoped — touched nothing, leaving a
      // single orphaned tombstone outside `ctx`'s claim.
      const self = await tx.$executeRaw`
        UPDATE "Node" SET "deletedAt" = ${deletedAt}
        WHERE id = ${node.id} AND "roomId" = ${ctx.roomId} AND ${withinScope(ctx)} AND "deletedAt" IS NULL`
      return { id: node.id, deletedNodes: descendants + self }
    })
  }
}
