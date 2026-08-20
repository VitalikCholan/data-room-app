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
   * A 302 target for the node's current version. The node itself arrives already
   * scope-checked by AccessGuard; the version row is keyed off node.currentVersionId,
   * so no query here can wander outside the caller's grant.
   *
   * Version rows with sizeBytes = 0 are reservations whose upload never confirmed.
   */
  async presignedUrlFor(_ctx: AccessContext, node: NodeRow) {
    if (node.type !== 'FILE') throw notFound()
    if (node.status !== 'ACTIVE' || !node.currentVersionId) throw notFound()
    const version = await this.prisma.fileVersion.findUnique({
      where: { id: node.currentVersionId },
    })
    if (!version || version.sizeBytes === BigInt(0)) throw notFound()

    // The presigned PUT from upload stays valid ~15 minutes past confirm, so the
    // object can be silently overwritten afterwards. Confirm pinned the verified
    // bytes' ETag as the checksum; anything else in the bucket — or nothing at
    // all — must never be served (Ruling 33).
    const head = await this.storage.head(version.blobKey)
    if (!head || (version.checksum !== null && head.etag !== version.checksum))
      throw new DomainError('GONE', 'File content is no longer available')

    return this.storage.presignGet(version.blobKey, {
      filename: node.name,
      inline: true,
    })
  }
}
