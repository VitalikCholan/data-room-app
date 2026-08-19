import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import type { AccessContext } from '../access/access-context'
import { DomainError } from '../common/errors'
import type { NodeRow } from '../access/access.resolver'
import { childPath } from './node-path'
import { NodesRepository } from './nodes.repository'
import type { SortMode } from './nodes.repository'

@Injectable()
export class NodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: NodesRepository,
  ) {}

  async list(
    ctx: AccessContext,
    parent: NodeRow,
    opts: { cursor?: string; limit?: number; sort?: SortMode },
  ) {
    if (parent.type !== 'FOLDER')
      throw new DomainError('INVALID_TARGET', 'Only folders can be listed')
    const { items, nextCursor } = await this.repo.listChildren(ctx, parent, {
      cursor: opts.cursor,
      limit: opts.limit ?? 50,
      sort: opts.sort ?? 'name',
    })
    return {
      items,
      nextCursor,
      breadcrumbs: await this.repo.breadcrumbs(ctx, parent),
      parent: {
        id: parent.id,
        name: parent.name,
        // Suppressed at the scope root so a guest has nothing to navigate up into.
        parentId: parent.id === ctx.scopeRootId ? null : parent.parentId,
      },
      role: ctx.role,
      scopeRootId: ctx.scopeRootId,
    }
  }

  async createFolder(ctx: AccessContext, parent: NodeRow, name: string) {
    if (parent.type !== 'FOLDER')
      throw new DomainError(
        'INVALID_TARGET',
        'Cannot create a folder inside a file',
      )
    return this.prisma.node.create({
      data: {
        roomId: parent.roomId,
        parentId: parent.id,
        type: 'FOLDER',
        name,
        path: childPath(parent),
        status: 'ACTIVE',
        createdById: ctx.userId!,
      },
    })
  }

  /** Conflicts are reported by the partial unique index and mapped to 409 by the Prisma filter. */
  async rename(_ctx: AccessContext, node: NodeRow, name: string) {
    return this.prisma.node.update({ where: { id: node.id }, data: { name } })
  }
}
