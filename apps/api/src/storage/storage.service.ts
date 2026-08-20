import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { AppEnv } from '../config/env'

export const PUT_TTL_SECONDS = 15 * 60
export const GET_TTL_SECONDS = 5 * 60
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
export const ALLOWED_MIME = 'application/pdf'

/** Server-derived, so a client cannot aim an upload at another room's key space. */
export function blobKeyFor(
  roomId: string,
  nodeId: string,
  versionNo: number,
): string {
  return `rooms/${roomId}/nodes/${nodeId}/v${versionNo}`
}

@Injectable()
export class StorageService {
  private readonly client: S3Client
  private readonly bucket: string

  constructor(config: ConfigService<AppEnv, true>) {
    this.bucket = config.get('S3_BUCKET', { infer: true })
    this.client = new S3Client({
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
      region: config.get('S3_REGION', { infer: true }),
      // MinIO and most S3-compatible providers require path-style addressing;
      // real S3 uses virtual-hosted. This is the one genuine config difference.
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY_ID', { infer: true }),
        secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', { infer: true }),
      },
    })
  }

  /**
   * A presigned PUT cannot constrain content length — `content-length-range` exists
   * only in POST policies. The size cap therefore lives in confirm(), not here.
   */
  async presignPut(key: string, contentType: string) {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: PUT_TTL_SECONDS },
    )
    return { url, expiresAt: new Date(Date.now() + PUT_TTL_SECONDS * 1000) }
  }

  async presignGet(key: string, opts: { filename: string; inline: boolean }) {
    const disposition = `${opts.inline ? 'inline' : 'attachment'}; filename="${opts.filename.replace(/"/g, '')}"`
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: disposition,
        ResponseContentType: ALLOWED_MIME,
      }),
      { expiresIn: GET_TTL_SECONDS },
    )
  }

  async head(
    key: string,
  ): Promise<{ contentLength: number; contentType: string } | null> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )
      return {
        contentLength: Number(out.ContentLength ?? 0),
        contentType: out.ContentType ?? '',
      }
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode
      if (status === 404 || status === 403) return null
      throw error
    }
  }

  async remove(key: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    )
  }
}
