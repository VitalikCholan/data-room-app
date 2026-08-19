import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
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
    const totals = await this.rollup.forSubtree(ctx.roomId, node)
    const [row] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count
      FROM "Share" s
      JOIN "Node" n ON n.id = s."nodeId"
      WHERE s."revokedAt" IS NULL
        AND n."roomId" = ${ctx.roomId}
        AND (n.id = ${node.id} OR n.path LIKE ${subtreeLikePattern(node)})`
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
        WHERE "roomId" = ${ctx.roomId} AND path LIKE ${subtreeLikePattern(node)} AND "deletedAt" IS NULL`
      // Scoped by roomId too, not only id: `node` here always arrives pre-authorized
      // via AccessGuard on every real route, but nothing in the type system enforces
      // that. Without this second condition a (ctx, node) pair assembled by a future
      // caller from two different rooms would still tombstone this one row even though
      // the descendants UPDATE above — correctly roomId-scoped — touched nothing,
      // leaving a single orphaned tombstone in a room `ctx` has no claim on.
      const self = await tx.$executeRaw`
        UPDATE "Node" SET "deletedAt" = ${deletedAt}
        WHERE id = ${node.id} AND "roomId" = ${ctx.roomId} AND "deletedAt" IS NULL`
      return { id: node.id, deletedNodes: descendants + self }
    })
  }
}
