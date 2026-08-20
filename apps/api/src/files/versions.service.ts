import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import type { AccessContext } from '../access/access-context'
import type { NodeRow } from '../access/access.resolver'
import { DomainError, notFound } from '../common/errors'

@Injectable()
export class VersionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * History for one file, newest first. The node arrives already scope-checked by
   * AccessGuard and every row is filtered by its id, so this cannot reach outside the
   * caller's grant. Reservation rows (sizeBytes = 0) are upload slots whose PUT never
   * confirmed — they are not history and must never be offered for restore.
   */
  async list(_ctx: AccessContext, node: NodeRow) {
    if (node.type !== 'FILE') throw notFound()
    const versions = await this.prisma.fileVersion.findMany({
      where: { nodeId: node.id, sizeBytes: { gt: 0 } },
      orderBy: { versionNo: 'desc' },
    })
    return versions.map((v) => ({
      id: v.id,
      versionNo: v.versionNo,
      sizeBytes: v.sizeBytes,
      mimeType: v.mimeType,
      createdAt: v.createdAt,
      isCurrent: v.id === node.currentVersionId,
    }))
  }

  /**
   * Restoring copies the old version forward under a new number instead of moving the
   * pointer back. History stays append-only, so "current" is always the highest
   * number — which is what lets the sweep recognise an abandoned upload as "numbered
   * above current".
   *
   * `checksum` is copied with `blobKey`, and this is load-bearing rather than tidy:
   * the read path refuses to serve a version whose stored ETag no longer matches its
   * recorded checksum (Ruling 33), and refuses one with no recorded checksum at all.
   * A copy that dropped it would therefore make every restored file answer 410 — which
   * is the *safe* direction. The dangerous version of this bug was the earlier read
   * path that tolerated null: it skipped the comparison instead of failing, so a
   * restored file was served as a 302 to bytes nobody had verified.
   */
  async restore(ctx: AccessContext, node: NodeRow, versionId: string) {
    if (node.type !== 'FILE') throw notFound()
    const source = await this.prisma.fileVersion.findFirst({
      where: { id: versionId, nodeId: node.id },
    })
    if (!source) throw notFound()
    if (source.sizeBytes === BigInt(0)) throw notFound()
    if (source.id === node.currentVersionId)
      throw new DomainError('VALIDATION', 'That version is already current')

    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.fileVersion.findFirstOrThrow({
        where: { nodeId: node.id },
        orderBy: { versionNo: 'desc' },
      })
      const created = await tx.fileVersion.create({
        data: {
          nodeId: node.id,
          versionNo: latest.versionNo + 1,
          // Two version rows share a blobKey after a restore. That is intentional:
          // the bytes are immutable, so copying the key is cheaper than copying the
          // object, and version deletion is not a feature.
          blobKey: source.blobKey,
          sizeBytes: source.sizeBytes,
          mimeType: source.mimeType,
          checksum: source.checksum,
          createdById: ctx.userId!,
        },
      })
      return tx.node.update({
        where: { id: node.id },
        data: { currentVersionId: created.id, sizeBytes: created.sizeBytes },
      })
    })
  }
}
