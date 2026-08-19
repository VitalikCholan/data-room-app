import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { notFound } from '../common/errors'
import { ROOT_PATH } from '../nodes/node-path'
import { RollupService } from '../nodes/rollup.service'

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rollup: RollupService,
  ) {}

  /** Room and root node are created together — a room without a root node has no valid share target. */
  async create(ownerId: string, name: string) {
    const roomId = randomUUID()
    const rootNodeId = randomUUID()
    return this.prisma.$transaction(async (tx) => {
      const room = await tx.dataRoom.create({
        data: { id: roomId, ownerId, name, rootNodeId },
      })
      await tx.node.create({
        data: {
          id: rootNodeId,
          roomId,
          parentId: null,
          type: 'FOLDER',
          name,
          path: ROOT_PATH,
          status: 'ACTIVE',
          createdById: ownerId,
        },
      })
      return room
    })
  }

  async listOwned(ownerId: string) {
    const rooms = await this.prisma.dataRoom.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
    })
    return Promise.all(
      rooms.map(async (room) => ({
        ...room,
        rollup: await this.rollup.forSubtree(room.id, {
          id: room.rootNodeId,
          path: ROOT_PATH,
        }),
      })),
    )
  }

  async findOwned(ownerId: string, roomId: string) {
    const room = await this.prisma.dataRoom.findFirst({
      where: { id: roomId, ownerId },
    })
    if (!room) throw notFound()
    return room
  }

  async rename(ownerId: string, roomId: string, name: string) {
    const room = await this.findOwned(ownerId, roomId)
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.dataRoom.update({
        where: { id: room.id },
        data: { name },
      })
      await tx.node.update({ where: { id: room.rootNodeId }, data: { name } })
      return updated
    })
  }

  async remove(ownerId: string, roomId: string) {
    const room = await this.findOwned(ownerId, roomId)
    await this.prisma.dataRoom.delete({ where: { id: room.id } })
    return { id: room.id }
  }

  /** Rooms reachable through a live share granted to this email, deduplicated by room. */
  async listSharedWithMe(email: string) {
    const shares = await this.prisma.share.findMany({
      where: {
        mode: 'USER',
        granteeEmail: email.toLowerCase(),
        revokedAt: null,
        node: { deletedAt: null },
      },
      include: { node: { include: { room: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return shares.map((s) => ({
      shareId: s.id,
      role: s.role,
      roomId: s.node.roomId,
      roomName: s.node.room.name,
      nodeId: s.nodeId,
      nodeName: s.node.name,
      nodeType: s.node.type,
      isWholeRoom: s.nodeId === s.node.room.rootNodeId,
    }))
  }
}
