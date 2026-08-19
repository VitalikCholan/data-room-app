import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { DomainError, notFound } from '../common/errors'
import type { AuthUser } from '../auth/auth.service'
import { ancestorIds, childPath, isWithinSubtree } from '../nodes/node-path'
import { AccessContext } from './access-context'
import { hashShareToken } from './share-token'

export type NodeRow = {
  id: string
  roomId: string
  parentId: string | null
  type: 'FOLDER' | 'FILE'
  name: string
  path: string
  status: 'PENDING' | 'ACTIVE'
  currentVersionId: string | null
  sizeBytes: bigint | null
  deletedAt: Date | null
  updatedAt: Date
  createdAt: Date
}

type Input = { user?: AuthUser; shareToken?: string }

/**
 * The single authorization decision for the whole application. Every controller that
 * touches a node or a room resolves its `AccessContext` here — never re-derives it —
 * so "can this caller see this row" has exactly one implementation to get right.
 */
@Injectable()
export class AccessResolver {
  constructor(private readonly prisma: PrismaService) {}

  async forNode(
    input: Input & { nodeId: string },
  ): Promise<{ ctx: AccessContext; node: NodeRow }> {
    const node = (await this.prisma.node.findUnique({
      where: { id: input.nodeId },
    })) as NodeRow | null
    if (!node) throw notFound()
    return this.resolveForNode(node, input)
  }

  async forRoom(
    input: Input & { roomId: string },
  ): Promise<{ ctx: AccessContext; node: NodeRow }> {
    const room = await this.prisma.dataRoom.findUnique({
      where: { id: input.roomId },
    })
    if (!room) throw notFound()
    const root = (await this.prisma.node.findUnique({
      where: { id: room.rootNodeId },
    })) as NodeRow | null
    if (!root) throw notFound()
    return this.resolveForNode(root, input)
  }

  private async resolveForNode(
    node: NodeRow,
    input: Input,
  ): Promise<{ ctx: AccessContext; node: NodeRow }> {
    const room = await this.prisma.dataRoom.findUniqueOrThrow({
      where: { id: node.roomId },
    })

    // 1. Owner — scope is the whole room. Checked before any share lookup: an owner's
    //    access never depends on a Share row existing at all.
    if (input.user && room.ownerId === input.user.id) {
      const root = await this.prisma.node.findUniqueOrThrow({
        where: { id: room.rootNodeId },
      })
      await this.assertNotDeleted(node)
      return {
        node,
        ctx: {
          role: 'OWNER',
          roomId: room.id,
          scopeRootId: root.id,
          scopePath: childPath(root),
          userId: input.user.id,
        },
      }
    }

    // 2. A live grant on this node or any ancestor. Deepest grant wins, so the most
    //    specific role applies once more than one role exists. A caller with no matching
    //    row here — stranger or revoked share — falls straight through to notFound()
    //    below; the tombstone check never runs for them, so a deleted node behind a
    //    share they never held still reads as 404, not 410.
    const candidateIds = [...ancestorIds(node.path), node.id]
    const tokenHash = input.shareToken ? hashShareToken(input.shareToken) : null
    const email = input.user?.email.toLowerCase() ?? null

    const grants = await this.prisma.$queryRaw<
      {
        id: string
        role: 'VIEWER'
        nodeId: string
        nodePath: string
        nodeDeletedAt: Date | null
      }[]
    >`
      SELECT s.id, s.role, s."nodeId", n.path AS "nodePath", n."deletedAt" AS "nodeDeletedAt"
      FROM "Share" s
      JOIN "Node" n ON n.id = s."nodeId"
      WHERE s."nodeId" = ANY(${candidateIds}::text[])
        AND s."revokedAt" IS NULL
        AND ( (s.mode = 'PUBLIC_LINK' AND s."tokenHash" = ${tokenHash})
           OR (s.mode = 'USER'        AND s."granteeEmail" = ${email}) )
      ORDER BY length(n.path) DESC
      LIMIT 1`

    const grant = grants[0]
    if (!grant) throw notFound()

    const scopeRoot = await this.prisma.node.findUniqueOrThrow({
      where: { id: grant.nodeId },
    })
    // Defensive: candidateIds is derived from node's own ancestor chain, so a grant
    // found there must already contain node — this can never actually fail, but it
    // keeps the invariant checked in code rather than only in the query that built it.
    if (!isWithinSubtree(node, scopeRoot.id, scopeRoot.path)) throw notFound()

    // 3. Tombstone check runs only after access is confirmed, never before — a stranger
    //    must see 404, not 410, or the 410 itself would confirm something existed there.
    await this.assertNotDeleted(node)

    return {
      node,
      ctx: {
        role: 'VIEWER',
        roomId: node.roomId,
        scopeRootId: scopeRoot.id,
        scopePath: childPath(scopeRoot),
        userId: input.user?.id,
        shareToken: input.shareToken,
        viaShareId: grant.id,
      },
    }
  }

  /**
   * The node's own `path` already lists every ancestor, so checking it and the node
   * together is one query, no recursion.
   */
  private async assertNotDeleted(node: NodeRow) {
    if (node.deletedAt)
      throw new DomainError('GONE', 'This item was deleted by the owner')
    const ids = ancestorIds(node.path)
    if (ids.length === 0) return
    const rows = await this.prisma.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM "Node" WHERE id = ANY(${ids}::text[]) AND "deletedAt" IS NOT NULL LIMIT 1`
    if (rows.length > 0)
      throw new DomainError('GONE', 'This item was deleted by the owner')
  }
}
