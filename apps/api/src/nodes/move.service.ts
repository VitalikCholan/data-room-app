import { Injectable } from '@nestjs/common'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import type { AccessContext } from '../access/access-context'
import { DomainError, notFound } from '../common/errors'
import { childPath } from './node-path'

type LockedNode = {
  id: string
  roomId: string
  parentId: string | null
  path: string
  name: string
  type: 'FOLDER' | 'FILE'
}

@Injectable()
export class MoveService {
  constructor(private readonly prisma: PrismaService) {}

  async move(ctx: AccessContext, sourceId: string, targetParentId: string) {
    if (sourceId === ctx.scopeRootId)
      throw new DomainError('INVALID_TARGET', 'The root folder cannot be moved')

    return this.prisma.$transaction(async (tx) => {
      // Lock both endpoints so a concurrent move cannot slip between the cycle
      // check and the UPDATE.
      const locked = await tx.$queryRaw<LockedNode[]>`
        SELECT id, "roomId", "parentId", path, name, type
        FROM "Node"
        WHERE id IN (${sourceId}, ${targetParentId})
          AND "roomId" = ${ctx.roomId}
          AND "deletedAt" IS NULL
        FOR UPDATE`

      const src = locked.find((n) => n.id === sourceId)
      const dst = locked.find((n) => n.id === targetParentId)
      if (!src || !dst) throw notFound()

      if (dst.id === src.id)
        throw new DomainError(
          'MOVE_CYCLE',
          'A folder cannot be moved into itself',
        )
      // The destination's own path lists its ancestors, so containment is a prefix test.
      if (dst.path.startsWith(childPath(src)))
        throw new DomainError(
          'MOVE_CYCLE',
          'A folder cannot be moved into its own subfolder',
        )
      if (dst.type !== 'FOLDER')
        throw new DomainError(
          'INVALID_TARGET',
          'Files cannot contain other items',
        )
      if (src.parentId === dst.id)
        return tx.node.findUniqueOrThrow({ where: { id: src.id } })

      const oldPrefix = childPath(src)
      const newPrefix = `${childPath(dst)}${src.id}/`

      try {
        // Descendants. The source's own path holds ancestors only, so this pattern
        // never matches the source row itself — that update is separate, below.
        //
        // The `::int` cast is load-bearing, not decoration: node-postgres sends the
        // bound parameter untyped, and Postgres resolves the overload of
        // `substring(text FROM <param>)` by the parameter's apparent type. Left
        // untyped it picks the POSIX-regexp overload `substring(text FROM pattern
        // text)` instead of the position overload `substring(text FROM start int)` —
        // silently treating the offset as a regex and writing back whatever
        // substring of `path` happens to match those digits, not the intended
        // suffix. Confirmed by reproduction: without the cast, moving a node whose
        // id happened to contain the digits of the offset corrupted its
        // descendants' paths with that matched fragment instead of the real
        // remainder.
        await tx.$executeRaw`
          UPDATE "Node"
          SET path = ${newPrefix} || substring(path from ${oldPrefix.length + 1}::int)
          WHERE "roomId" = ${src.roomId} AND path LIKE ${`${oldPrefix}%`}`

        return await tx.node.update({
          where: { id: src.id },
          data: { parentId: dst.id, path: childPath(dst) },
        })
      } catch (error) {
        // The partial unique index is the authority on collisions; a pre-check would race.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new DomainError(
            'NAME_CONFLICT',
            `"${src.name}" already exists in the destination folder`,
          )
        }
        throw error
      }
    })
  }
}
