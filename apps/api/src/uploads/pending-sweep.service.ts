import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { PrismaService } from '../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'

const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000

/**
 * A browser closing between the presigned PUT and confirm leaves a PENDING node,
 * its v1 reservation row, and possibly an unverified object in the bucket. Nothing
 * user-facing ever shows a PENDING node, so after a grace period they are garbage.
 * (Under Ruling 32 every file has exactly one version, so abandoned *re-uploads*
 * cannot exist and this sweep only handles brand-new files.)
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
    if (result.nodes)
      this.logger.log(
        `Swept ${result.nodes} pending nodes (${result.versions} version rows)`,
      )
  }

  /** System job, not a user read: it deliberately runs without an AccessContext. */
  async sweep(olderThan: Date): Promise<{ nodes: number; versions: number }> {
    const staleNodes = await this.prisma.node.findMany({
      where: { status: 'PENDING', createdAt: { lt: olderThan } },
      include: { versions: true },
    })

    let versions = 0
    for (const node of staleNodes) {
      // Blob removal first, outside any transaction: if it fails the rows survive
      // and the next hourly run retries. Deleting the node cascades its versions.
      for (const version of node.versions) {
        await this.safeRemove(version.blobKey)
        versions += 1
      }
      await this.prisma.node.delete({ where: { id: node.id } })
    }

    return { nodes: staleNodes.length, versions }
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
