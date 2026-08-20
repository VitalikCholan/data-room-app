import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { PrismaService } from '../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'

const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000

/**
 * A browser closing between the presigned PUT and confirm leaves two kinds of orphan:
 *
 *  1. a PENDING node — a brand-new file that never activated, plus its v1 reservation
 *     row and possibly an unverified object in the bucket. Nothing user-facing ever
 *     shows a PENDING node, so after a grace period it is garbage.
 *  2. an unconfirmed version numbered *above* the node's current version — an
 *     abandoned re-upload of a file that is otherwise alive and serving.
 */
@Injectable()
export class PendingSweepService {
  private readonly logger = new Logger(PendingSweepService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async scheduled() {
    const result = await this.sweep(new Date(Date.now() - ORPHAN_AGE_MS))
    if (result.nodes || result.versions)
      this.logger.log(
        `Swept ${result.nodes} pending nodes and ${result.versions} abandoned versions`,
      )
  }

  /** System job, not a user read: it deliberately runs without an AccessContext. */
  async sweep(olderThan: Date): Promise<{ nodes: number; versions: number }> {
    const staleNodes = await this.prisma.node.findMany({
      where: { status: 'PENDING', createdAt: { lt: olderThan } },
      include: { versions: true },
    })

    for (const node of staleNodes) {
      // Blob removal first, outside any transaction: if it fails the rows survive
      // and the next hourly run retries. Deleting the node cascades its versions.
      for (const version of node.versions)
        await this.safeRemove(version.blobKey)
      await this.prisma.node.delete({ where: { id: node.id } })
    }

    // An unconfirmed reservation (sizeBytes = 0) on a live node, numbered above that
    // node's current version, can only be an abandoned re-upload: confirm is the only
    // thing that gives a version bytes, and restore always *appends* a higher number
    // rather than rewinding the pointer — so real history is never above current.
    // Raw SQL because the comparison is against a column of another row (the current
    // version's number), which Prisma's filter language cannot express.
    const abandoned = await this.prisma.$queryRaw<
      { id: string; blobKey: string }[]
    >`
      SELECT v.id, v."blobKey"
      FROM "FileVersion" v
      JOIN "Node" n ON n.id = v."nodeId"
      LEFT JOIN "FileVersion" cur ON cur.id = n."currentVersionId"
      WHERE v."sizeBytes" = 0
        AND v."createdAt" < ${olderThan}
        AND n.status = 'ACTIVE'
        AND v.id <> coalesce(n."currentVersionId", '')
        AND v."versionNo" > coalesce(cur."versionNo", 0)`

    for (const version of abandoned) {
      await this.safeRemove(version.blobKey)
      await this.prisma.fileVersion.delete({ where: { id: version.id } })
    }

    return { nodes: staleNodes.length, versions: abandoned.length }
  }

  private async safeRemove(key: string) {
    try {
      await this.storage.remove(key)
    } catch (error) {
      // A missing object is the normal case for a cancelled upload.
      this.logger.warn(`Could not remove ${key}: ${String(error)}`)
    }
  }
}
