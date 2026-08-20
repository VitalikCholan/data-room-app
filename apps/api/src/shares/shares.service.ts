import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import { AppEnv } from '../config/env'
import type { AccessContext } from '../access/access-context'
import type { NodeRow } from '../access/access.resolver'
import { DomainError, notFound } from '../common/errors'
import { ancestorIds } from '../nodes/node-path'
import { generateShareToken, hashShareToken } from '../access/share-token'
import { CreateShareDto } from './dto/shares.dto'

@Injectable()
export class SharesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  async create(ctx: AccessContext, node: NodeRow, dto: CreateShareDto) {
    if (dto.mode === 'PUBLIC_LINK') {
      const { token, tokenHash } = generateShareToken()
      const share = await this.prisma.share.create({
        data: {
          nodeId: node.id,
          mode: 'PUBLIC_LINK',
          role: 'VIEWER',
          tokenHash,
          createdById: ctx.userId!,
        },
      })
      // The only moment the raw token exists outside the client that receives it.
      return {
        share: this.redact(share),
        token,
        url: `${this.config.get('PUBLIC_APP_URL', { infer: true })}/s/${token}`,
      }
    }

    const email = dto.email!.toLowerCase()
    const grantee = await this.prisma.user.findUnique({ where: { email } })
    const share = await this.prisma.share.upsert({
      where: { nodeId_granteeEmail: { nodeId: node.id, granteeEmail: email } },
      create: {
        nodeId: node.id,
        mode: 'USER',
        role: 'VIEWER',
        granteeEmail: email,
        granteeId: grantee?.id ?? null,
        createdById: ctx.userId!,
      },
      update: { revokedAt: null },
    })
    return { share: this.redact(share) }
  }

  async list(_ctx: AccessContext, node: NodeRow) {
    const shares = await this.prisma.share.findMany({
      where: { nodeId: node.id },
      orderBy: { createdAt: 'desc' },
    })
    return shares.map((s) => this.redact(s))
  }

  /** Only the room owner may revoke; anyone else is told the share does not exist. */
  async revoke(userId: string, shareId: string) {
    const share = await this.prisma.share.findFirst({
      where: { id: shareId, node: { room: { ownerId: userId } } },
    })
    if (!share) throw notFound()
    const updated = await this.prisma.share.update({
      where: { id: share.id },
      data: { revokedAt: new Date() },
    })
    return this.redact(updated)
  }

  /**
   * Guest bootstrap. A token that never existed is 404; a token that did exist but is
   * revoked, or whose target is gone, is 410 — the holder already has the secret, so
   * telling them it stopped working leaks nothing and reads far better.
   */
  async resolveToken(token: string) {
    const share = await this.prisma.share.findUnique({
      where: { tokenHash: hashShareToken(token) },
      include: { node: { include: { room: true } } },
    })
    if (!share) throw notFound()
    if (share.revokedAt)
      throw new DomainError('GONE', 'This link is no longer active')
    if (share.node.deletedAt)
      throw new DomainError('GONE', 'This item was deleted by the owner')

    const ancestors = ancestorIds(share.node.path)
    if (ancestors.length) {
      const deleted = await this.prisma.node.findFirst({
        where: { id: { in: ancestors }, deletedAt: { not: null } },
      })
      if (deleted)
        throw new DomainError('GONE', 'This item was deleted by the owner')
    }

    return {
      role: share.role,
      roomId: share.node.roomId,
      roomName: share.node.room.name,
      node: {
        id: share.node.id,
        name: share.node.name,
        type: share.node.type,
      },
    }
  }

  private redact(share: {
    id: string
    nodeId: string
    mode: string
    role: string
    granteeEmail: string | null
    granteeId: string | null
    createdAt: Date
    revokedAt: Date | null
  }) {
    return {
      id: share.id,
      nodeId: share.nodeId,
      mode: share.mode,
      role: share.role,
      granteeEmail: share.granteeEmail,
      granteeId: share.granteeId,
      createdAt: share.createdAt,
      revokedAt: share.revokedAt,
      // tokenHash is deliberately never serialized.
    }
  }
}
