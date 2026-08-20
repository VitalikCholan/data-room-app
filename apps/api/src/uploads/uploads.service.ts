import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import type { AccessContext } from '../access/access-context'
import type { NodeRow } from '../access/access.resolver'
import { DomainError, notFound } from '../common/errors'
import { childPath } from '../nodes/node-path'
import { resolveAvailableName } from '../nodes/name-conflict'
import { NodesRepository } from '../nodes/nodes.repository'
import {
  ALLOWED_MIME,
  blobKeyFor,
  MAX_UPLOAD_BYTES,
  StorageService,
} from '../storage/storage.service'
import { PresignUploadDto } from './dto/uploads.dto'

@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly nodes: NodesRepository,
  ) {}

  async presign(ctx: AccessContext, dto: PresignUploadDto) {
    if (dto.mimeType !== ALLOWED_MIME)
      throw new DomainError('UNSUPPORTED_TYPE', 'Only PDF files are supported')
    if (dto.sizeBytes > MAX_UPLOAD_BYTES)
      throw new DomainError('TOO_LARGE', 'Files must be 50 MB or smaller')

    const parent = (await this.prisma.node.findFirst({
      where: {
        id: dto.parentId,
        roomId: ctx.roomId,
        type: 'FOLDER',
        deletedAt: null,
      },
    })) as NodeRow | null
    if (!parent) throw notFound()

    // Type-agnostic on purpose: the partial unique index node_name_uniq covers
    // folders too, so a folder holding the name would fail the insert just as a
    // file would.
    const existing = await this.prisma.node.findFirst({
      where: {
        parentId: parent.id,
        roomId: ctx.roomId,
        deletedAt: null,
        name: { equals: dto.name, mode: 'insensitive' },
      },
      include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
    })

    if (existing && !dto.onConflict) {
      throw new DomainError(
        'NAME_CONFLICT',
        `"${dto.name}" already exists in this folder`,
        {
          existingNodeId: existing.id,
          // A folder occupies the name without ever being versioned, so
          // currentVersionNo only makes sense for a file.
          ...(existing.type === 'FILE'
            ? { currentVersionNo: existing.versions[0]?.versionNo ?? 1 }
            : {}),
          existingUpdatedAt: existing.updatedAt,
        },
      )
    }

    // The only strategy is KEEP_BOTH (Ruling 32): a conflicting name is suffixed,
    // never versioned onto the existing node — which also covers a colliding
    // FOLDER, since a folder can never be versioned.
    const name = existing
      ? resolveAvailableName(
          dto.name,
          await this.nodes.takenSiblingNames(ctx, parent.id),
        )
      : dto.name
    return this.presignNewFile(ctx, parent, name)
  }

  /**
   * The row is created before the URL is handed out, so the client knows nodeId
   * immediately and an abandoned upload is always discoverable by the sweep.
   */
  private async presignNewFile(
    ctx: AccessContext,
    parent: NodeRow,
    name: string,
  ) {
    const nodeId = randomUUID()
    const versionId = randomUUID()
    const blobKey = blobKeyFor(ctx.roomId, nodeId, 1)

    await this.prisma.$transaction([
      this.prisma.node.create({
        data: {
          id: nodeId,
          roomId: ctx.roomId,
          parentId: parent.id,
          type: 'FILE',
          name,
          path: childPath(parent),
          status: 'PENDING',
          createdById: ctx.userId!,
        },
      }),
      this.prisma.fileVersion.create({
        data: {
          id: versionId,
          nodeId,
          versionNo: 1,
          blobKey,
          sizeBytes: BigInt(0),
          mimeType: ALLOWED_MIME,
          createdById: ctx.userId!,
        },
      }),
    ])

    const { url, expiresAt } = await this.storage.presignPut(
      blobKey,
      ALLOWED_MIME,
    )
    return {
      nodeId,
      versionId,
      versionNo: 1,
      blobKey,
      uploadUrl: url,
      expiresAt,
      name,
    }
  }

  /**
   * The only enforcement point for size and type. A presigned PUT cannot cap length,
   * so without this HEAD the stored size is whatever the client claimed — and every
   * subtree total would inherit the lie.
   */
  async confirm(ctx: AccessContext, nodeId: string, versionId: string) {
    const node = await this.prisma.node.findFirst({
      where: { id: nodeId, roomId: ctx.roomId, deletedAt: null },
    })
    if (!node) throw notFound()
    const version = await this.prisma.fileVersion.findFirst({
      where: { id: versionId, nodeId },
    })
    if (!version) throw notFound()

    if (node.status === 'ACTIVE' && node.currentVersionId === version.id)
      return node

    const head = await this.storage.head(version.blobKey)
    if (!head)
      throw new DomainError(
        'UPLOAD_NOT_FOUND',
        'The upload did not reach storage; retry',
      )

    if (head.contentLength > MAX_UPLOAD_BYTES) {
      await this.rejectUpload(node.id, version.id, version.blobKey)
      throw new DomainError('TOO_LARGE', 'Files must be 50 MB or smaller')
    }
    if (head.contentType !== ALLOWED_MIME) {
      await this.rejectUpload(node.id, version.id, version.blobKey)
      throw new DomainError('UNSUPPORTED_TYPE', 'Only PDF files are supported')
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.fileVersion.update({
        where: { id: version.id },
        data: {
          sizeBytes: BigInt(head.contentLength),
          mimeType: head.contentType,
          // The presigned PUT stays valid ~15 min after confirm, so the object can
          // be silently overwritten. Recording the confirmed ETag pins which bytes
          // were verified; read-side comparison lands with the files controller.
          checksum: head.etag,
        },
      })
      return tx.node.update({
        where: { id: node.id },
        data: {
          status: 'ACTIVE',
          currentVersionId: version.id,
          sizeBytes: BigInt(head.contentLength),
        },
      })
    })
  }

  /**
   * Under the scope cut a rejected upload is always a PENDING node's only version,
   * so the version row is deleted and the node tombstoned together. Blob removal
   * stays first and outside the transaction: if it fails, the rows survive and a
   * retried confirm re-attempts the removal.
   */
  private async rejectUpload(
    nodeId: string,
    versionId: string,
    blobKey: string,
  ) {
    await this.storage.remove(blobKey)
    await this.prisma.$transaction([
      this.prisma.fileVersion.delete({ where: { id: versionId } }),
      this.prisma.node.update({
        where: { id: nodeId },
        data: { deletedAt: new Date() },
      }),
    ])
  }
}
