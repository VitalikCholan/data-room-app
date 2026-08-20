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

    if (existing && dto.onConflict === 'NEW_VERSION') {
      // The sibling lookup above is type-agnostic, so the name in the way can be a
      // FOLDER. Versioning it is not "not implemented" — it is meaningless: a folder
      // has no bytes and no FileVersion history to append to. Say so explicitly
      // rather than silently falling back to KEEP_BOTH, which would put a file the
      // user asked to *replace* next to the folder under a suffixed name.
      if (existing.type !== 'FILE') {
        throw new DomainError(
          'NOT_VERSIONABLE',
          `"${dto.name}" is a folder; only a file can receive a new version`,
          { existingNodeId: existing.id, existingType: existing.type },
        )
      }
      return this.presignNewVersion(
        ctx,
        existing.id,
        existing.versions[0]?.versionNo ?? 0,
        dto.name,
      )
    }

    // KEEP_BOTH: a conflicting name is suffixed rather than versioned onto the
    // existing node — which is also the only sane answer for a colliding FOLDER.
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
   * The node stays ACTIVE on its current version while the new one uploads, so an
   * in-flight v2 never blanks v1: `confirm` is the only thing that moves
   * `currentVersionId`. A reservation row is written first (sizeBytes 0) so an
   * abandoned re-upload is discoverable by the sweep.
   */
  private async presignNewVersion(
    ctx: AccessContext,
    nodeId: string,
    latestVersionNo: number,
    name: string,
  ) {
    const versionNo = latestVersionNo + 1
    const versionId = randomUUID()
    const blobKey = blobKeyFor(ctx.roomId, nodeId, versionNo)

    await this.prisma.fileVersion.create({
      data: {
        id: versionId,
        nodeId,
        versionNo,
        blobKey,
        sizeBytes: BigInt(0),
        mimeType: ALLOWED_MIME,
        createdById: ctx.userId!,
      },
    })

    const { url, expiresAt } = await this.storage.presignPut(
      blobKey,
      ALLOWED_MIME,
    )
    return {
      nodeId,
      versionId,
      versionNo,
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

    // A rejected *new version* of a live file must leave the file alone; only a
    // brand-new file's own failed first upload takes its node down with it.
    const dropNode = node.status === 'PENDING'
    // A zero-byte object is not a usable file, and accepting it produces a node that is
    // permanently broken rather than merely empty: `sizeBytes = 0` is exactly how the
    // read path recognises an *unconfirmed reservation*, so this version would be
    // skipped by FilesService and VersionsService forever while the node sat ACTIVE
    // pointing at it — a file that lists but 404s in the viewer, with no way back.
    // Reject it here, with the same blob-and-row cleanup as the other rejections.
    if (head.contentLength === 0) {
      await this.rejectUpload(node.id, version.id, version.blobKey, dropNode)
      throw new DomainError('EMPTY_UPLOAD', 'The uploaded file is empty')
    }
    if (head.contentLength > MAX_UPLOAD_BYTES) {
      await this.rejectUpload(node.id, version.id, version.blobKey, dropNode)
      throw new DomainError('TOO_LARGE', 'Files must be 50 MB or smaller')
    }
    if (head.contentType !== ALLOWED_MIME) {
      await this.rejectUpload(node.id, version.id, version.blobKey, dropNode)
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
   * The reservation row always goes; the node is tombstoned only when this upload was
   * its first (`dropNode`), because a rejected new version of a live file must not
   * delete the file the user was trying to replace. Blob removal stays first and
   * outside the transaction: if it fails, the rows survive and a retried confirm
   * re-attempts the removal.
   */
  private async rejectUpload(
    nodeId: string,
    versionId: string,
    blobKey: string,
    dropNode: boolean,
  ) {
    await this.storage.remove(blobKey)
    await this.prisma.$transaction([
      this.prisma.fileVersion.delete({ where: { id: versionId } }),
      ...(dropNode
        ? [
            this.prisma.node.update({
              where: { id: nodeId },
              data: { deletedAt: new Date() },
            }),
          ]
        : []),
    ])
  }
}
