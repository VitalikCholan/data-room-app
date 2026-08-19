import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { subtreeLikePattern } from './node-path'

export type Rollup = { folders: number; files: number; bytes: number }

@Injectable()
export class RollupService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One aggregate over the (roomId, path varchar_pattern_ops) index. No recursion and
   * no join: `sizeBytes` is denormalized onto Node from the current version precisely
   * so this query never touches FileVersion.
   */
  async forSubtree(
    roomId: string,
    node: { id: string; path: string },
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
        AND status = 'ACTIVE'`
    return {
      folders: Number(row.folders),
      files: Number(row.files),
      bytes: Number(row.bytes),
    }
  }
}
