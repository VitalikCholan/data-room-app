import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import type { AccessContext } from '../access/access-context'
import type { NodeRow } from '../access/access.resolver'
import { DomainError, notFound } from '../common/errors'
import { StorageService } from '../storage/storage.service'

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * A 302 target for the node's current version, or for an explicitly named one. The
   * node itself arrives already scope-checked by AccessGuard; the version row is
   * looked up with `nodeId` bound to that node, so a version id belonging to another
   * file — even one the caller can otherwise see — resolves to nothing rather than to
   * someone else's bytes.
   *
   * Version rows with sizeBytes = 0 are reservations whose upload never confirmed.
   */
  async presignedUrlFor(
    _ctx: AccessContext,
    node: NodeRow,
    versionId?: string,
  ) {
    if (node.type !== 'FILE') throw notFound()
    if (node.status !== 'ACTIVE' || !node.currentVersionId) throw notFound()
    const version = versionId
      ? await this.prisma.fileVersion.findFirst({
          where: { id: versionId, nodeId: node.id },
        })
      : await this.prisma.fileVersion.findUnique({
          where: { id: node.currentVersionId },
        })
    if (!version || version.sizeBytes === BigInt(0)) throw notFound()

    // The presigned PUT from upload stays valid ~15 minutes past confirm, so the
    // object can be silently overwritten afterwards. Confirm pinned the verified
    // bytes' ETag as the checksum; anything else in the bucket — or nothing at
    // all — must never be served (Ruling 33).
    //
    // A *missing* checksum is treated the same way, deliberately. Tolerating null here
    // would be the worse failure by far: instead of refusing, the API would hand out a
    // 302 to bytes nobody ever verified, and any path that forgot to record a checksum
    // (a restore that dropped it, a hand-written row, a future writer) would silently
    // disarm the check rather than fail loudly. Nothing writes null today — confirm sets
    // it from its own HEAD, restore copies it, the seed HEADs for it — so this closes
    // the path instead of protecting rows that exist.
    const head = await this.storage.head(version.blobKey)
    if (!head || version.checksum === null || head.etag !== version.checksum)
      throw new DomainError('GONE', 'File content is no longer available')

    return this.storage.presignGet(version.blobKey, {
      filename: node.name,
      inline: true,
    })
  }
}
