# Data Room — Plan 03: Files, Sharing and Search API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan set:** this is one of six. Order: 01 foundation → 02 tree API → 03 files & sharing API → 04 web shell → 05 web browser → 06 sharing UI & release. See `2026-08-19-data-room-00-overview.md`.

**Goal:** Complete the API — direct-to-bucket uploads with versioning, file viewing, share creation and revocation, and name search — so the frontend has a finished contract to build against.

**Architecture:** File bytes never pass through the API. `presign` creates the database row first and hands back a presigned PUT; `confirm` verifies the object with a bucket `HEAD` and is the only place the 50 MB and PDF-only rules are enforced. Reads are a 302 to a five-minute presigned GET, so the bucket stays private. Shares attach to a node and are inherited by prefix, so the Task 9 resolver needs no changes.

**Tech Stack:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@nestjs/schedule`, Prisma raw SQL with `pg_trgm`, Jest + supertest, MinIO.

**Spec:** `docs/superpowers/specs/2026-08-19-data-room-design.md`

> **[VOID — RULING 34, 2026-08-20] The cut below was REVERSED by the user; versioning and search shipped after all.
> The block is kept only as a record of what was decided when. Do not implement from it.**
>
> **SCOPE CUT (Ruling 32, 2026-08-20, approved by user):** Extra credit is out of scope. This changes the tasks below as follows — the task text is kept for reference, but implementation follows this list:
> - **Task 14:** no `NEW_VERSION` conflict strategy. `onConflict` accepts only `KEEP_BOTH`. A name conflict without a strategy is still `409 NAME_CONFLICT`. Every file has exactly one `FileVersion` row (versionNo 1); `presignNewVersion` is not built. The `FileVersion` table stays — it holds the blobKey and makes versioning a pure re-add later.
> - **Task 15:** no `GET /nodes/:id/versions`, no restore endpoint, no `VersionsService.list/restore`. Keep: `GET /nodes/:id/content` (302 to presigned GET) and the PENDING-node orphan sweep. The abandoned-version half of the sweep is dropped (no v2+ can exist).
> - **Task 17:** no search service/controller/module and no search tests. Keep only `openapi.ts` emission and the whole-suite gate. The `pg_trgm` GIN index stays in the schema (harmless, already migrated).
> - Batching: Task 13+14 = one dispatch; Task 15+16+17 = one dispatch. Deep review only on Task 14 confirm path (Ruling 23).

**Prerequisite:** Plan 02 complete — `AccessResolver`, `AccessGuard`, `NodesRepository`, `RollupService` all in place.

**Done when:** A PDF can be uploaded from a browser through a presigned URL, viewed, re-uploaded as a new version, restored, searched for by name, and shared by public link or by email — with revocation working and `openapi.json` emitted for the frontend.

## Global Constraints

- Node 20+, pnpm 9+. Package manager is pnpm workspaces only — no Turborepo, no Nx.
- All packages live under `apps/*`. There is no `packages/` directory and no shared types package.
- `apps/web` must never import from `apps/api` or from `@prisma/client`. Frontend types come only from `apps/web/src/api/schema.d.ts`, generated from `openapi.json`.
- Uploads: PDF only (`application/pdf`), hard cap **50 MB**, enforced only in `UploadsService.confirm` via a bucket `HEAD`.
- Presigned PUT TTL 15 minutes. Presigned GET TTL 5 minutes.
- Share tokens: 32 random bytes, base64url. Store **only** `sha256(token)` in `Share.tokenHash`. Show the token once.
- Access JWT TTL 15 minutes. Refresh cookie TTL 7 days, `httpOnly; Secure; SameSite=Lax; Path=/`.
- **Prisma 7**: no `url` in `datasource` (it lives in `prisma.config.ts`); the generated client is imported from `src/generated/prisma/client` (namespace `Prisma`, `PrismaClient`) and `src/generated/prisma/enums` (enums) — never from `@prisma/client`; `PrismaClient` requires a `@prisma/adapter-pg` adapter.
- Blob keys are always derived server-side as `rooms/{roomId}/nodes/{nodeId}/v{versionNo}`. Never client-supplied.
- HTTP codes are fixed by spec §4.3: 401 unauthenticated · 404 no access (never 403 — it would confirm existence) · 403 role insufficient · 410 deleted ancestor or revoked link · 409 name conflict or move cycle · 413 over 50 MB · 415 wrong MIME · 422 validation.
- `Node.status = PENDING` rows are excluded from every listing, for every caller.
- Soft delete has no user-facing restore. No trash UI. No editor role. No OS folder upload. No audit log.
- Every repository method that reads nodes takes an `AccessContext` and applies its scope prefix. A read query that does not carry scope is a bug.
- Commit after every task. Conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`).

---

### Task 13: StorageService against a real bucket

**Files:**
- Create: `apps/api/src/storage/storage.service.ts`, `apps/api/src/storage/storage.module.ts`
- Test: `apps/api/src/storage/blob-key.spec.ts`, `apps/api/test/storage.e2e-spec.ts`

**Interfaces:**
- Consumes: `S3_*` env from Plan 01
- Produces:
  - `blobKeyFor(roomId: string, nodeId: string, versionNo: number): string`
  - `StorageService.presignPut(key: string, contentType: string): Promise<{ url: string; expiresAt: Date }>`
  - `StorageService.presignGet(key: string, opts: { filename: string; inline: boolean }): Promise<string>`
  - `StorageService.head(key: string): Promise<{ contentLength: number; contentType: string } | null>`
  - `StorageService.remove(key: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`apps/api/src/storage/blob-key.spec.ts`:
```ts
import { blobKeyFor } from './storage.service'

describe('blobKeyFor', () => {
  it('is derived from ids, never from a client-supplied filename', () => {
    expect(blobKeyFor('room-1', 'node-2', 3)).toBe('rooms/room-1/nodes/node-2/v3')
  })

  it('gives every version its own key so history is immutable', () => {
    expect(blobKeyFor('r', 'n', 1)).not.toBe(blobKeyFor('r', 'n', 2))
  })
})
```

`apps/api/test/storage.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing'
import { AppModule } from '../src/app.module'
import { blobKeyFor, StorageService } from '../src/storage/storage.service'
import { randomUUID } from 'node:crypto'

/** Runs against MinIO from docker-compose, so the presigned signature path is real. */
describe('StorageService', () => {
  let storage: StorageService
  const key = blobKeyFor('test-room', randomUUID(), 1)
  const body = Buffer.from('%PDF-1.7\n% test fixture\n')

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    storage = mod.get(StorageService)
  })

  it('returns null from head for an object that does not exist', async () => {
    await expect(storage.head(blobKeyFor('nope', 'nope', 1))).resolves.toBeNull()
  })

  it('accepts a PUT to the presigned url and reports the real size and type', async () => {
    const { url, expiresAt } = await storage.presignPut(key, 'application/pdf')
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now())

    const put = await fetch(url, { method: 'PUT', body, headers: { 'Content-Type': 'application/pdf' } })
    expect(put.ok).toBe(true)

    await expect(storage.head(key)).resolves.toEqual({ contentLength: body.byteLength, contentType: 'application/pdf' })
  })

  it('serves the bytes back through a presigned GET', async () => {
    const url = await storage.presignGet(key, { filename: 'fixture.pdf', inline: true })
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(body)
  })

  it('removes an object', async () => {
    await storage.remove(key)
    await expect(storage.head(key)).resolves.toBeNull()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `docker compose up -d` then `pnpm --filter api test -- blob-key` and `pnpm --filter api test:e2e -- storage`
Expected: FAIL — `Cannot find module './storage.service'`.

- [ ] **Step 3: Implement the service**

`apps/api/src/storage/storage.service.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { AppEnv } from '../config/env'

export const PUT_TTL_SECONDS = 15 * 60
export const GET_TTL_SECONDS = 5 * 60
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
export const ALLOWED_MIME = 'application/pdf'

/** Server-derived, so a client cannot aim an upload at another room's key space. */
export function blobKeyFor(roomId: string, nodeId: string, versionNo: number): string {
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
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
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

  async head(key: string): Promise<{ contentLength: number; contentType: string } | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return { contentLength: Number(out.ContentLength ?? 0), contentType: out.ContentType ?? '' }
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      if (status === 404 || status === 403) return null
      throw error
    }
  }

  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }
}
```

`apps/api/src/storage/storage.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { StorageService } from './storage.service'

@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
```

Add `StorageModule` to `AppModule.imports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter api test -- blob-key` then `pnpm --filter api test:e2e -- storage`
Expected: all PASS. A failure on the PUT step means MinIO is not running or `S3_FORCE_PATH_STYLE` is wrong — both are the exact classes of bug this task exists to surface locally.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/storage apps/api/test/storage.e2e-spec.ts apps/api/src/app.module.ts
git commit -m "feat(api): s3-compatible storage service with presigned put/get, head and delete"
```

---

### Task 14: Two-phase upload with conflict strategies and versioning

**Files:**
- Create: `apps/api/src/uploads/uploads.service.ts`, `uploads.controller.ts`, `uploads.module.ts`, `dto/uploads.dto.ts`
- Test: `apps/api/test/uploads.e2e-spec.ts`

**Interfaces:**
- Consumes: `StorageService`, `NodesRepository.takenSiblingNames`, `resolveAvailableName`, `AccessContext`, `AccessGuard`, `RequireOwner`
- Produces:
  - `UploadsService.presign(ctx, dto): Promise<{ nodeId: string; versionId: string; versionNo: number; blobKey: string; uploadUrl: string; expiresAt: Date; name: string }>`
  - `UploadsService.confirm(ctx, nodeId, versionId): Promise<NodeRow>`
  - `POST /rooms/:roomId/uploads/presign`, `POST /uploads/:nodeId/confirm`

**Deviation from spec §4.2, deliberate:** `confirm` takes `versionId` in the body. The spec's `POST /uploads/:nodeId/confirm` alone is ambiguous once a node has several versions in flight; naming the version makes confirm idempotent and unambiguous. Record this in the README.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/uploads.e2e-spec.ts`:
```ts
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter'
import { PrismaExceptionFilter } from '../src/common/filters/prisma-exception.filter'
import { BigIntInterceptor } from '../src/common/interceptors/bigint.interceptor'
import { StorageService } from '../src/storage/storage.service'
import { createRoom, createUser, prisma } from './factories'

const PDF = Buffer.from('%PDF-1.7\n% e2e fixture\n')

describe('uploads', () => {
  let app: INestApplication
  let storage: StorageService

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = mod.createNestApplication()
    app.use(cookieParser())
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    app.useGlobalFilters(new PrismaExceptionFilter(), new DomainExceptionFilter())
    app.useGlobalInterceptors(new BigIntInterceptor())
    await app.init()
    storage = mod.get(StorageService)
  })
  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  async function fixture() {
    const owner = await createUser()
    const token = (await request(app.getHttpServer()).post('/auth/login').send({ email: owner.email, password: owner.password })).body
      .accessToken as string
    const { roomId, rootId } = await createRoom(owner.id)
    return { owner, token, roomId, rootId, auth: { Authorization: `Bearer ${token}` } }
  }

  async function upload(f: Awaited<ReturnType<typeof fixture>>, name: string, body = PDF, onConflict?: string) {
    const presign = await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/uploads/presign`)
      .set(f.auth)
      .send({ parentId: f.rootId, name, sizeBytes: body.byteLength, mimeType: 'application/pdf', ...(onConflict ? { onConflict } : {}) })
    return { presign, body }
  }

  async function put(url: string, body: Buffer) {
    const res = await fetch(url, { method: 'PUT', body, headers: { 'Content-Type': 'application/pdf' } })
    expect(res.ok).toBe(true)
  }

  it('creates a PENDING node at presign that no listing shows', async () => {
    const f = await fixture()
    const { presign } = await upload(f, 'quarterly.pdf')
    expect(presign.status).toBe(201)
    expect(presign.body).toMatchObject({ versionNo: 1, name: 'quarterly.pdf' })

    const node = await prisma.node.findUniqueOrThrow({ where: { id: presign.body.nodeId } })
    expect(node.status).toBe('PENDING')

    const list = await request(app.getHttpServer()).get(`/rooms/${f.roomId}/nodes`).set(f.auth).expect(200)
    expect(list.body.items).toEqual([])
  })

  it('activates the node on confirm and takes size and type from the bucket, not the client', async () => {
    const f = await fixture()
    const { presign } = await upload(f, 'real.pdf')
    await put(presign.body.uploadUrl, PDF)

    const confirmed = await request(app.getHttpServer())
      .post(`/uploads/${presign.body.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presign.body.versionId })
      .expect(201)

    expect(confirmed.body).toMatchObject({ status: 'ACTIVE', sizeBytes: PDF.byteLength })
    const version = await prisma.fileVersion.findUniqueOrThrow({ where: { id: presign.body.versionId } })
    expect(Number(version.sizeBytes)).toBe(PDF.byteLength)
  })

  it('lies about its size in vain — confirm overwrites the claim', async () => {
    const f = await fixture()
    const presign = await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/uploads/presign`)
      .set(f.auth)
      .send({ parentId: f.rootId, name: 'liar.pdf', sizeBytes: 999_999, mimeType: 'application/pdf' })
      .expect(201)
    await put(presign.body.uploadUrl, PDF)

    const confirmed = await request(app.getHttpServer())
      .post(`/uploads/${presign.body.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presign.body.versionId })
      .expect(201)
    expect(confirmed.body.sizeBytes).toBe(PDF.byteLength)
  })

  it('returns 409 UPLOAD_NOT_FOUND when confirm runs before the PUT', async () => {
    const f = await fixture()
    const { presign } = await upload(f, 'never-uploaded.pdf')
    const res = await request(app.getHttpServer())
      .post(`/uploads/${presign.body.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presign.body.versionId })
      .expect(409)
    expect(res.body.code).toBe('UPLOAD_NOT_FOUND')

    const node = await prisma.node.findUniqueOrThrow({ where: { id: presign.body.nodeId } })
    expect(node.status).toBe('PENDING')
  })

  it('rejects an object over the cap with 413 and deletes it', async () => {
    const f = await fixture()
    const { presign } = await upload(f, 'huge.pdf')
    const oversized = Buffer.alloc(50 * 1024 * 1024 + 1, 0x20)
    await put(presign.body.uploadUrl, oversized)

    await request(app.getHttpServer())
      .post(`/uploads/${presign.body.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presign.body.versionId })
      .expect(413)

    await expect(storage.head(presign.body.blobKey)).resolves.toBeNull()
  })

  it('rejects a non-PDF object with 415 and deletes it', async () => {
    const f = await fixture()
    const { presign } = await upload(f, 'sneaky.pdf')
    const res = await fetch(presign.body.uploadUrl, {
      method: 'PUT',
      body: Buffer.from('<html>not a pdf</html>'),
      headers: { 'Content-Type': 'text/html' },
    })
    expect(res.ok).toBe(true)

    await request(app.getHttpServer())
      .post(`/uploads/${presign.body.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presign.body.versionId })
      .expect(415)
  })

  it('is idempotent: a second confirm returns the same node without a new version', async () => {
    const f = await fixture()
    const { presign } = await upload(f, 'twice.pdf')
    await put(presign.body.uploadUrl, PDF)
    const first = await request(app.getHttpServer())
      .post(`/uploads/${presign.body.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presign.body.versionId })
      .expect(201)
    const second = await request(app.getHttpServer())
      .post(`/uploads/${presign.body.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: presign.body.versionId })
      .expect(201)

    expect(second.body.id).toBe(first.body.id)
    expect(await prisma.fileVersion.count({ where: { nodeId: presign.body.nodeId } })).toBe(1)
  })

  it('returns 409 NAME_CONFLICT with the existing version when no strategy is given', async () => {
    const f = await fixture()
    const first = await upload(f, 'invoice.pdf')
    await put(first.presign.body.uploadUrl, PDF)
    await request(app.getHttpServer())
      .post(`/uploads/${first.presign.body.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: first.presign.body.versionId })
      .expect(201)

    const clash = await upload(f, 'INVOICE.pdf')
    expect(clash.presign.status).toBe(409)
    expect(clash.presign.body).toMatchObject({
      code: 'NAME_CONFLICT',
      details: { existingNodeId: first.presign.body.nodeId, currentVersionNo: 1 },
    })
  })

  it('NEW_VERSION adds v2 to the existing node and leaves v1 readable until confirm', async () => {
    const f = await fixture()
    const first = await upload(f, 'report.pdf')
    await put(first.presign.body.uploadUrl, PDF)
    await request(app.getHttpServer())
      .post(`/uploads/${first.presign.body.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: first.presign.body.versionId })
      .expect(201)

    const second = await upload(f, 'report.pdf', PDF, 'NEW_VERSION')
    expect(second.presign.body).toMatchObject({ nodeId: first.presign.body.nodeId, versionNo: 2 })

    // Before confirm the file still shows v1 — an in-flight upload must not blank a live file.
    const midFlight = await prisma.node.findUniqueOrThrow({ where: { id: first.presign.body.nodeId } })
    expect(midFlight.currentVersionId).toBe(first.presign.body.versionId)
    expect(midFlight.status).toBe('ACTIVE')

    await put(second.presign.body.uploadUrl, PDF)
    await request(app.getHttpServer())
      .post(`/uploads/${first.presign.body.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: second.presign.body.versionId })
      .expect(201)

    const after = await prisma.node.findUniqueOrThrow({ where: { id: first.presign.body.nodeId } })
    expect(after.currentVersionId).toBe(second.presign.body.versionId)
    expect(await prisma.fileVersion.count({ where: { nodeId: after.id } })).toBe(2)
  })

  it('KEEP_BOTH creates a separate node with a (2) suffix', async () => {
    const f = await fixture()
    const first = await upload(f, 'deck.pdf')
    await put(first.presign.body.uploadUrl, PDF)
    await request(app.getHttpServer())
      .post(`/uploads/${first.presign.body.nodeId}/confirm`)
      .set(f.auth)
      .send({ versionId: first.presign.body.versionId })
      .expect(201)

    const second = await upload(f, 'deck.pdf', PDF, 'KEEP_BOTH')
    expect(second.presign.body.name).toBe('deck (2).pdf')
    expect(second.presign.body.nodeId).not.toBe(first.presign.body.nodeId)
  })

  it('rejects a non-PDF mime type at presign with 415, before any URL is issued', async () => {
    const f = await fixture()
    await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/uploads/presign`)
      .set(f.auth)
      .send({ parentId: f.rootId, name: 'notes.txt', sizeBytes: 10, mimeType: 'text/plain' })
      .expect(415)
  })

  it('refuses uploads from a read-only viewer with 403', async () => {
    const f = await fixture()
    const stranger = await createUser()
    const strangerToken = (
      await request(app.getHttpServer()).post('/auth/login').send({ email: stranger.email, password: stranger.password })
    ).body.accessToken
    await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/uploads/presign`)
      .set({ Authorization: `Bearer ${strangerToken}` })
      .send({ parentId: f.rootId, name: 'x.pdf', sizeBytes: 10, mimeType: 'application/pdf' })
      .expect(404)
  })
})
```

The last case expects `404`, not `403`: a stranger with no grant at all must not learn the room exists. `403` is reserved for a caller who *does* hold a viewer grant.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter api test:e2e -- uploads`
Expected: FAIL — 404 on the presign route.

- [ ] **Step 3: Implement the DTOs**

`apps/api/src/uploads/dto/uploads.dto.ts`:
```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsIn, IsInt, IsMimeType, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator'

const SAFE_NAME = /^[^/\\\x00-\x1f]+$/

export class PresignUploadDto {
  @ApiProperty()
  @IsString()
  parentId: string

  @ApiProperty({ example: 'FY23 Audit.pdf' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(SAFE_NAME, { message: 'name must not contain slashes or control characters' })
  name: string

  @ApiProperty({ description: 'Client-reported size; re-read from the bucket on confirm' })
  @IsInt()
  @Min(1)
  sizeBytes: number

  @ApiProperty({ example: 'application/pdf' })
  @IsMimeType()
  mimeType: string

  @ApiPropertyOptional({
    enum: ['NEW_VERSION', 'KEEP_BOTH'],
    description: 'Omit to receive 409 NAME_CONFLICT and let the user choose',
  })
  @IsOptional()
  @IsIn(['NEW_VERSION', 'KEEP_BOTH'])
  onConflict?: 'NEW_VERSION' | 'KEEP_BOTH'
}

export class ConfirmUploadDto {
  @ApiProperty({ description: 'Version id returned by presign' })
  @IsString()
  versionId: string
}
```

- [ ] **Step 4: Implement the service**

`apps/api/src/uploads/uploads.service.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { AccessContext } from '../access/access-context'
import { NodeRow } from '../access/access.resolver'
import { DomainError, notFound } from '../common/errors'
import { childPath } from '../nodes/node-path'
import { resolveAvailableName } from '../nodes/name-conflict'
import { NodesRepository } from '../nodes/nodes.repository'
import { ALLOWED_MIME, blobKeyFor, MAX_UPLOAD_BYTES, StorageService } from '../storage/storage.service'
import { PresignUploadDto } from './dto/uploads.dto'

@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly nodes: NodesRepository,
  ) {}

  async presign(ctx: AccessContext, dto: PresignUploadDto) {
    if (dto.mimeType !== ALLOWED_MIME) throw new DomainError('UNSUPPORTED_TYPE', 'Only PDF files are supported')
    if (dto.sizeBytes > MAX_UPLOAD_BYTES) throw new DomainError('TOO_LARGE', 'Files must be 50 MB or smaller')

    const parent = (await this.prisma.node.findFirst({
      where: { id: dto.parentId, roomId: ctx.roomId, type: 'FOLDER', deletedAt: null },
    })) as NodeRow | null
    if (!parent) throw notFound()

    const existing = await this.prisma.node.findFirst({
      where: { parentId: parent.id, deletedAt: null, type: 'FILE', name: { equals: dto.name, mode: 'insensitive' } },
      include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
    })

    if (existing && !dto.onConflict) {
      throw new DomainError('NAME_CONFLICT', `"${dto.name}" already exists in this folder`, {
        existingNodeId: existing.id,
        currentVersionNo: existing.versions[0]?.versionNo ?? 1,
        existingUpdatedAt: existing.updatedAt,
      })
    }

    if (existing && dto.onConflict === 'NEW_VERSION') return this.presignNewVersion(ctx, existing.id, existing.versions[0]?.versionNo ?? 0, dto.name)

    const name = existing ? resolveAvailableName(dto.name, await this.nodes.takenSiblingNames(parent.id)) : dto.name
    return this.presignNewFile(ctx, parent, name)
  }

  /**
   * The row is created before the URL is handed out, so the client knows nodeId
   * immediately and an abandoned upload is always discoverable by the sweep.
   */
  private async presignNewFile(ctx: AccessContext, parent: NodeRow, name: string) {
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
        data: { id: versionId, nodeId, versionNo: 1, blobKey, sizeBytes: BigInt(0), mimeType: ALLOWED_MIME, createdById: ctx.userId! },
      }),
    ])

    const { url, expiresAt } = await this.storage.presignPut(blobKey, ALLOWED_MIME)
    return { nodeId, versionId, versionNo: 1, blobKey, uploadUrl: url, expiresAt, name }
  }

  /** The node stays ACTIVE on its current version, so an in-flight v2 never blanks v1. */
  private async presignNewVersion(ctx: AccessContext, nodeId: string, latestVersionNo: number, name: string) {
    const versionNo = latestVersionNo + 1
    const versionId = randomUUID()
    const blobKey = blobKeyFor(ctx.roomId, nodeId, versionNo)

    await this.prisma.fileVersion.create({
      data: { id: versionId, nodeId, versionNo, blobKey, sizeBytes: BigInt(0), mimeType: ALLOWED_MIME, createdById: ctx.userId! },
    })

    const { url, expiresAt } = await this.storage.presignPut(blobKey, ALLOWED_MIME)
    return { nodeId, versionId, versionNo, blobKey, uploadUrl: url, expiresAt, name }
  }

  /**
   * The only enforcement point for size and type. A presigned PUT cannot cap length,
   * so without this HEAD the stored size is whatever the client claimed — and every
   * subtree total would inherit the lie.
   */
  async confirm(ctx: AccessContext, nodeId: string, versionId: string) {
    const node = await this.prisma.node.findFirst({ where: { id: nodeId, roomId: ctx.roomId, deletedAt: null } })
    if (!node) throw notFound()
    const version = await this.prisma.fileVersion.findFirst({ where: { id: versionId, nodeId } })
    if (!version) throw notFound()

    if (node.status === 'ACTIVE' && node.currentVersionId === version.id) return node

    const head = await this.storage.head(version.blobKey)
    if (!head) throw new DomainError('UPLOAD_NOT_FOUND', 'The upload did not reach storage; retry')

    if (head.contentLength > MAX_UPLOAD_BYTES) {
      await this.rejectUpload(node.id, version.id, version.blobKey, node.status === 'PENDING')
      throw new DomainError('TOO_LARGE', 'Files must be 50 MB or smaller')
    }
    if (head.contentType !== ALLOWED_MIME) {
      await this.rejectUpload(node.id, version.id, version.blobKey, node.status === 'PENDING')
      throw new DomainError('UNSUPPORTED_TYPE', 'Only PDF files are supported')
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.fileVersion.update({
        where: { id: version.id },
        data: { sizeBytes: BigInt(head.contentLength), mimeType: head.contentType },
      })
      return tx.node.update({
        where: { id: node.id },
        data: { status: 'ACTIVE', currentVersionId: version.id, sizeBytes: BigInt(head.contentLength) },
      })
    })
  }

  private async rejectUpload(nodeId: string, versionId: string, blobKey: string, dropNode: boolean) {
    await this.storage.remove(blobKey)
    await this.prisma.fileVersion.delete({ where: { id: versionId } })
    if (dropNode) await this.prisma.node.update({ where: { id: nodeId }, data: { deletedAt: new Date() } })
  }
}
```

- [ ] **Step 5: Implement the controller and module**

`apps/api/src/uploads/uploads.controller.ts`:
```ts
import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Access, AccessGuard, RequireOwner } from '../access/access.guard'
import { AccessContext } from '../access/access-context'
import { UploadsService } from './uploads.service'
import { ConfirmUploadDto, PresignUploadDto } from './dto/uploads.dto'

@ApiTags('uploads')
@ApiBearerAuth('access-token')
@Controller()
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('rooms/:roomId/uploads/presign')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({ summary: 'Reserve a file row and return a presigned PUT url' })
  @ApiResponse({ status: 409, description: 'NAME_CONFLICT — resend with onConflict to resolve' })
  @ApiResponse({ status: 413, description: 'Declared size exceeds 50 MB' })
  @ApiResponse({ status: 415, description: 'Only application/pdf is accepted' })
  presign(@Access() ctx: AccessContext, @Body() dto: PresignUploadDto) {
    return this.uploads.presign(ctx, dto)
  }

  @Post('uploads/:nodeId/confirm')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({ summary: 'Verify the uploaded object and activate the file' })
  @ApiResponse({ status: 409, description: 'UPLOAD_NOT_FOUND — the object is not in storage yet' })
  @ApiResponse({ status: 413, description: 'Stored object exceeds 50 MB; it has been deleted' })
  @ApiResponse({ status: 415, description: 'Stored object is not a PDF; it has been deleted' })
  confirm(@Access() ctx: AccessContext, @Param('nodeId') nodeId: string, @Body() dto: ConfirmUploadDto) {
    return this.uploads.confirm(ctx, nodeId, dto.versionId)
  }
}
```

`apps/api/src/uploads/uploads.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { NodesModule } from '../nodes/nodes.module'
import { StorageModule } from '../storage/storage.module'
import { UploadsController } from './uploads.controller'
import { UploadsService } from './uploads.service'

@Module({
  imports: [AccessModule, NodesModule, StorageModule],
  controllers: [UploadsController],
  providers: [UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}
```

Add `UploadsModule` to `AppModule.imports`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter api test:e2e -- uploads`
Expected: all thirteen PASS. The load-bearing ones: the client's declared size is discarded, an over-cap object is deleted rather than recorded, and an in-flight v2 leaves v1 serving.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/uploads apps/api/test/uploads.e2e-spec.ts apps/api/src/app.module.ts
git commit -m "feat(api): presign/confirm uploads with head verification, versioning and conflict strategies"
```

---

### Task 15: File viewing, version history, and the orphan sweep

**Files:**
- Create: `apps/api/src/files/files.controller.ts`, `versions.service.ts`, `files.module.ts`
- Create: `apps/api/src/uploads/pending-sweep.service.ts`
- Modify: `apps/api/src/uploads/uploads.module.ts`, `apps/api/src/app.module.ts` (add `ScheduleModule.forRoot()`)
- Test: `apps/api/test/files.e2e-spec.ts`, `apps/api/test/pending-sweep.e2e-spec.ts`

**Interfaces:**
- Consumes: `StorageService`, `AccessGuard`, `AccessNode`, `RequireOwner`, `NodeRow`
- Produces:
  - `VersionsService.list(ctx, node)`, `VersionsService.restore(ctx, node, versionId)`
  - `VersionsService.presignedUrlFor(ctx, node, versionId?): Promise<string>`
  - `PendingSweepService.sweep(olderThan: Date): Promise<{ nodes: number; versions: number }>`
  - `GET /nodes/:id/content`, `GET /nodes/:id/versions`, `POST /nodes/:id/versions/:versionId/restore`

- [ ] **Step 1: Write the failing tests**

`apps/api/test/files.e2e-spec.ts`:
```ts
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter'
import { PrismaExceptionFilter } from '../src/common/filters/prisma-exception.filter'
import { BigIntInterceptor } from '../src/common/interceptors/bigint.interceptor'
import { hashShareToken } from '../src/access/share-token'
import { createFile, createRoom, createShare, createUser, prisma } from './factories'

describe('file view and versions', () => {
  let app: INestApplication

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = mod.createNestApplication()
    app.use(cookieParser())
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    app.useGlobalFilters(new PrismaExceptionFilter(), new DomainExceptionFilter())
    app.useGlobalInterceptors(new BigIntInterceptor())
    await app.init()
  })
  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  async function fixture() {
    const owner = await createUser()
    const token = (await request(app.getHttpServer()).post('/auth/login').send({ email: owner.email, password: owner.password })).body
      .accessToken as string
    const { roomId, rootId, root } = await createRoom(owner.id)
    const file = await createFile({ ...root, roomId }, 'MSA.pdf', owner.id)
    return { owner, token, roomId, rootId, file, auth: { Authorization: `Bearer ${token}` } }
  }

  it('redirects to a short-lived presigned url rather than proxying bytes', async () => {
    const f = await fixture()
    const res = await request(app.getHttpServer()).get(`/nodes/${f.file.id}/content`).set(f.auth).expect(302)
    expect(res.headers.location).toContain('X-Amz-Signature')
    expect(res.headers.location).toContain('X-Amz-Expires=300')
  })

  it('lets a public-link guest view a file inside the shared subtree', async () => {
    const f = await fixture()
    const token = 'view-token'
    await createShare({ nodeId: f.rootId, mode: 'PUBLIC_LINK', createdById: f.owner.id, tokenHash: hashShareToken(token) })
    await request(app.getHttpServer()).get(`/nodes/${f.file.id}/content`).set({ 'X-Share-Token': token }).expect(302)
  })

  it('lists versions newest first', async () => {
    const f = await fixture()
    await prisma.fileVersion.create({
      data: {
        nodeId: f.file.id,
        versionNo: 2,
        blobKey: `rooms/${f.roomId}/nodes/${f.file.id}/v2`,
        sizeBytes: BigInt(2048),
        mimeType: 'application/pdf',
        createdById: f.owner.id,
      },
    })
    const res = await request(app.getHttpServer()).get(`/nodes/${f.file.id}/versions`).set(f.auth).expect(200)
    expect(res.body.map((v: { versionNo: number }) => v.versionNo)).toEqual([2, 1])
    expect(res.body[0]).toHaveProperty('isCurrent', false)
  })

  it('restore makes an old version current under a new number', async () => {
    const f = await fixture()
    const v1 = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId: f.file.id, versionNo: 1 } })
    const v2 = await prisma.fileVersion.create({
      data: {
        nodeId: f.file.id,
        versionNo: 2,
        blobKey: `rooms/${f.roomId}/nodes/${f.file.id}/v2`,
        sizeBytes: BigInt(4096),
        mimeType: 'application/pdf',
        createdById: f.owner.id,
      },
    })
    await prisma.node.update({ where: { id: f.file.id }, data: { currentVersionId: v2.id, sizeBytes: BigInt(4096) } })

    await request(app.getHttpServer()).post(`/nodes/${f.file.id}/versions/${v1.id}/restore`).set(f.auth).expect(201)

    const node = await prisma.node.findUniqueOrThrow({ where: { id: f.file.id } })
    const versions = await prisma.fileVersion.findMany({ where: { nodeId: f.file.id }, orderBy: { versionNo: 'desc' } })
    expect(versions[0].versionNo).toBe(3)
    expect(versions[0].blobKey).toBe(v1.blobKey)
    expect(node.currentVersionId).toBe(versions[0].id)
    expect(Number(node.sizeBytes)).toBe(Number(v1.sizeBytes))
  })

  it('refuses restore from a read-only viewer with 403', async () => {
    const f = await fixture()
    const token = 'ro-token'
    await createShare({ nodeId: f.rootId, mode: 'PUBLIC_LINK', createdById: f.owner.id, tokenHash: hashShareToken(token) })
    const v1 = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId: f.file.id } })
    await request(app.getHttpServer())
      .post(`/nodes/${f.file.id}/versions/${v1.id}/restore`)
      .set({ 'X-Share-Token': token })
      .expect(403)
  })

  it('returns 410 once the owner deletes the file under a guest', async () => {
    const f = await fixture()
    const token = 'gone-view-token'
    await createShare({ nodeId: f.rootId, mode: 'PUBLIC_LINK', createdById: f.owner.id, tokenHash: hashShareToken(token) })
    await prisma.node.update({ where: { id: f.file.id }, data: { deletedAt: new Date() } })
    await request(app.getHttpServer()).get(`/nodes/${f.file.id}/content`).set({ 'X-Share-Token': token }).expect(410)
  })

  it('returns 404 for content on a folder', async () => {
    const f = await fixture()
    await request(app.getHttpServer()).get(`/nodes/${f.rootId}/content`).set(f.auth).expect(404)
  })
})
```

`apps/api/test/pending-sweep.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing'
import { AppModule } from '../src/app.module'
import { PendingSweepService } from '../src/uploads/pending-sweep.service'
import { StorageService, blobKeyFor } from '../src/storage/storage.service'
import { createFile, createRoom, createUser, prisma } from './factories'

describe('PendingSweepService', () => {
  let sweep: PendingSweepService
  let storage: StorageService

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    sweep = mod.get(PendingSweepService)
    storage = mod.get(StorageService)
  })
  afterAll(() => prisma.$disconnect())

  it('removes a stale PENDING node and its blob', async () => {
    const owner = await createUser()
    const { roomId, rootId } = await createRoom(owner.id)
    const nodeId = crypto.randomUUID()
    const blobKey = blobKeyFor(roomId, nodeId, 1)

    const { url } = await storage.presignPut(blobKey, 'application/pdf')
    await fetch(url, { method: 'PUT', body: Buffer.from('%PDF-1.7\n'), headers: { 'Content-Type': 'application/pdf' } })

    const old = new Date(Date.now() - 48 * 3600 * 1000)
    await prisma.node.create({
      data: { id: nodeId, roomId, parentId: rootId, type: 'FILE', name: 'abandoned.pdf', path: `/${rootId}/`, status: 'PENDING', createdById: owner.id, createdAt: old },
    })
    await prisma.fileVersion.create({
      data: { nodeId, versionNo: 1, blobKey, sizeBytes: BigInt(0), mimeType: 'application/pdf', createdById: owner.id, createdAt: old },
    })

    const result = await sweep.sweep(new Date(Date.now() - 24 * 3600 * 1000))
    expect(result.nodes).toBeGreaterThanOrEqual(1)
    await expect(prisma.node.findUnique({ where: { id: nodeId } })).resolves.toBeNull()
    await expect(storage.head(blobKey)).resolves.toBeNull()
  })

  it('leaves a fresh PENDING node alone — the user may still be uploading', async () => {
    const owner = await createUser()
    const { roomId, rootId } = await createRoom(owner.id)
    const node = await prisma.node.create({
      data: { roomId, parentId: rootId, type: 'FILE', name: 'in-flight.pdf', path: `/${rootId}/`, status: 'PENDING', createdById: owner.id },
    })
    await sweep.sweep(new Date(Date.now() - 24 * 3600 * 1000))
    await expect(prisma.node.findUnique({ where: { id: node.id } })).resolves.not.toBeNull()
  })

  it('removes an abandoned new-version upload without touching live history', async () => {
    const owner = await createUser()
    const { roomId, root } = await createRoom(owner.id)
    const file = await createFile({ ...root, roomId }, 'live.pdf', owner.id)
    const currentNo = 1
    const abandonedKey = blobKeyFor(roomId, file.id, currentNo + 1)

    const old = new Date(Date.now() - 48 * 3600 * 1000)
    const abandoned = await prisma.fileVersion.create({
      data: { nodeId: file.id, versionNo: currentNo + 1, blobKey: abandonedKey, sizeBytes: BigInt(0), mimeType: 'application/pdf', createdById: owner.id, createdAt: old },
    })

    const result = await sweep.sweep(new Date(Date.now() - 24 * 3600 * 1000))
    expect(result.versions).toBeGreaterThanOrEqual(1)
    await expect(prisma.fileVersion.findUnique({ where: { id: abandoned.id } })).resolves.toBeNull()
    // v1 is still current and still present.
    await expect(prisma.fileVersion.findFirst({ where: { nodeId: file.id, versionNo: 1 } })).resolves.not.toBeNull()
    await expect(prisma.node.findUniqueOrThrow({ where: { id: file.id } })).resolves.toMatchObject({ status: 'ACTIVE' })
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter api test:e2e -- files` and `pnpm --filter api test:e2e -- pending-sweep`
Expected: FAIL — routes and providers missing.

- [ ] **Step 3: Implement versions**

`apps/api/src/files/versions.service.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AccessContext } from '../access/access-context'
import { NodeRow } from '../access/access.resolver'
import { DomainError, notFound } from '../common/errors'
import { StorageService } from '../storage/storage.service'

@Injectable()
export class VersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

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

  /** Version rows with sizeBytes = 0 are reservations whose upload never confirmed. */
  async presignedUrlFor(_ctx: AccessContext, node: NodeRow, versionId?: string) {
    if (node.type !== 'FILE') throw notFound()
    const version = versionId
      ? await this.prisma.fileVersion.findFirst({ where: { id: versionId, nodeId: node.id } })
      : node.currentVersionId
        ? await this.prisma.fileVersion.findUnique({ where: { id: node.currentVersionId } })
        : null
    if (!version || version.sizeBytes === BigInt(0)) throw notFound()
    return this.storage.presignGet(version.blobKey, { filename: node.name, inline: true })
  }

  /**
   * Restoring copies the old version forward under a new number instead of moving the
   * pointer back. History stays append-only, so "current" is always the highest number
   * — which is what lets the sweep recognise an abandoned upload.
   */
  async restore(ctx: AccessContext, node: NodeRow, versionId: string) {
    if (node.type !== 'FILE') throw notFound()
    const source = await this.prisma.fileVersion.findFirst({ where: { id: versionId, nodeId: node.id } })
    if (!source) throw notFound()
    if (source.id === node.currentVersionId) throw new DomainError('VALIDATION', 'That version is already current')

    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.fileVersion.findFirstOrThrow({ where: { nodeId: node.id }, orderBy: { versionNo: 'desc' } })
      const created = await tx.fileVersion.create({
        data: {
          nodeId: node.id,
          versionNo: latest.versionNo + 1,
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
```

Two version rows can share a `blobKey` after a restore. That is intentional — the bytes are immutable, so copying the key is cheaper than copying the object, and version deletion is not a feature.

`apps/api/src/files/files.controller.ts`:
```ts
import { Controller, Get, Param, Post, Query, Redirect, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger'
import { Access, AccessGuard, AccessNode, RequireOwner } from '../access/access.guard'
import { AccessContext } from '../access/access-context'
import { NodeRow } from '../access/access.resolver'
import { VersionsService } from './versions.service'

@ApiTags('files')
@ApiBearerAuth('access-token')
@ApiSecurity('share-token')
@Controller('nodes')
export class FilesController {
  constructor(private readonly versions: VersionsService) {}

  @Get(':id/content')
  @UseGuards(AccessGuard)
  @Redirect('', 302)
  @ApiOperation({ summary: 'Redirect to a 5-minute presigned GET for viewing in the browser' })
  @ApiResponse({ status: 302, description: 'Location carries the presigned url' })
  @ApiResponse({ status: 410, description: 'Deleted by the owner' })
  async content(@Access() ctx: AccessContext, @AccessNode() node: NodeRow, @Query('version') version?: string) {
    return { url: await this.versions.presignedUrlFor(ctx, node, version), statusCode: 302 }
  }

  @Get(':id/versions')
  @UseGuards(AccessGuard)
  @ApiOperation({ summary: 'Version history, newest first' })
  list(@Access() ctx: AccessContext, @AccessNode() node: NodeRow) {
    return this.versions.list(ctx, node)
  }

  @Post(':id/versions/:versionId/restore')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({ summary: 'Make an earlier version current, as a new version' })
  @ApiResponse({ status: 403, description: 'Read-only access' })
  restore(@Access() ctx: AccessContext, @AccessNode() node: NodeRow, @Param('versionId') versionId: string) {
    return this.versions.restore(ctx, node, versionId)
  }
}
```

`apps/api/src/files/files.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { StorageModule } from '../storage/storage.module'
import { FilesController } from './files.controller'
import { VersionsService } from './versions.service'

@Module({
  imports: [AccessModule, StorageModule],
  controllers: [FilesController],
  providers: [VersionsService],
})
export class FilesModule {}
```

- [ ] **Step 4: Implement the sweep**

`apps/api/src/uploads/pending-sweep.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { PrismaService } from '../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'

const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000

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
    if (result.nodes || result.versions) this.logger.log(`Swept ${result.nodes} pending nodes and ${result.versions} abandoned versions`)
  }

  /**
   * Two kinds of orphan, both from a browser closing between PUT and confirm:
   *  1. a PENDING node — a brand-new file that never activated;
   *  2. a version numbered above the node's current version — an abandoned re-upload.
   *     Restore always appends a higher number, so "above current and unconfirmed"
   *     can only mean abandoned.
   */
  async sweep(olderThan: Date) {
    const staleNodes = await this.prisma.node.findMany({
      where: { status: 'PENDING', createdAt: { lt: olderThan } },
      include: { versions: true },
    })
    for (const node of staleNodes) {
      for (const version of node.versions) await this.safeRemove(version.blobKey)
      await this.prisma.node.delete({ where: { id: node.id } })
    }

    const abandoned = await this.prisma.$queryRaw<{ id: string; blobKey: string }[]>`
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
```

Register `PendingSweepService` in `UploadsModule.providers` and export it. Add `ScheduleModule.forRoot()` and `FilesModule` to `AppModule.imports`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter api test:e2e -- files` then `pnpm --filter api test:e2e -- pending-sweep`
Expected: all PASS. Note the sweep test that must *not* delete: a fresh PENDING node belongs to a user who may still be uploading.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/files apps/api/src/uploads apps/api/test apps/api/src/app.module.ts
git commit -m "feat(api): presigned file viewing, version history with restore, hourly orphan sweep"
```

---

### Task 16: Sharing — create, list, revoke, and the guest bootstrap

**Files:**
- Create: `apps/api/src/shares/shares.service.ts`, `shares.controller.ts`, `public-share.controller.ts`, `shares.module.ts`, `dto/shares.dto.ts`
- Test: `apps/api/test/shares.e2e-spec.ts`

**Interfaces:**
- Consumes: `generateShareToken`, `hashShareToken`, `AccessGuard`, `RequireOwner`, `JwtAuthGuard`, `PUBLIC_APP_URL`
- Produces:
  - `SharesService.create(ctx, node, dto): Promise<{ share; token?: string; url?: string }>` — the raw token appears in this response only
  - `SharesService.list(ctx, node)`, `SharesService.revoke(userId, shareId)`, `SharesService.resolveToken(token)`
  - `POST /nodes/:id/shares`, `GET /nodes/:id/shares`, `DELETE /shares/:id`, `GET /shared/:token`

- [ ] **Step 1: Write the failing tests**

`apps/api/test/shares.e2e-spec.ts`:
```ts
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter'
import { PrismaExceptionFilter } from '../src/common/filters/prisma-exception.filter'
import { BigIntInterceptor } from '../src/common/interceptors/bigint.interceptor'
import { hashShareToken } from '../src/access/share-token'
import { createFile, createFolder, createRoom, createUser, prisma } from './factories'

describe('sharing', () => {
  let app: INestApplication

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = mod.createNestApplication()
    app.use(cookieParser())
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    app.useGlobalFilters(new PrismaExceptionFilter(), new DomainExceptionFilter())
    app.useGlobalInterceptors(new BigIntInterceptor())
    await app.init()
  })
  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  async function fixture() {
    const owner = await createUser()
    const guest = await createUser()
    const ownerToken = (await request(app.getHttpServer()).post('/auth/login').send({ email: owner.email, password: owner.password })).body
      .accessToken as string
    const guestToken = (await request(app.getHttpServer()).post('/auth/login').send({ email: guest.email, password: guest.password })).body
      .accessToken as string
    const { roomId, rootId, root } = await createRoom(owner.id)
    const legal = await createFolder({ ...root, roomId }, 'Legal', owner.id)
    const msa = await createFile(legal, 'MSA.pdf', owner.id)
    return {
      owner,
      guest,
      roomId,
      rootId,
      legal,
      msa,
      auth: { Authorization: `Bearer ${ownerToken}` },
      guestAuth: { Authorization: `Bearer ${guestToken}` },
    }
  }

  it('creates a public link, returns the token once, and stores only its hash', async () => {
    const f = await fixture()
    const res = await request(app.getHttpServer()).post(`/nodes/${f.legal.id}/shares`).set(f.auth).send({ mode: 'PUBLIC_LINK' }).expect(201)

    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(res.body.url).toContain(`/s/${res.body.token}`)

    const stored = await prisma.share.findUniqueOrThrow({ where: { id: res.body.share.id } })
    expect(stored.tokenHash).toBe(hashShareToken(res.body.token))

    const listed = await request(app.getHttpServer()).get(`/nodes/${f.legal.id}/shares`).set(f.auth).expect(200)
    expect(listed.body[0]).not.toHaveProperty('token')
    expect(listed.body[0]).not.toHaveProperty('tokenHash')
  })

  it('bootstraps a guest from the token alone', async () => {
    const f = await fixture()
    const { token } = (await request(app.getHttpServer()).post(`/nodes/${f.legal.id}/shares`).set(f.auth).send({ mode: 'PUBLIC_LINK' })).body

    const res = await request(app.getHttpServer()).get(`/shared/${token}`).expect(200)
    expect(res.body).toMatchObject({ role: 'VIEWER', node: { id: f.legal.id, type: 'FOLDER' }, roomId: f.roomId })
  })

  it('lets the token holder list the shared folder but nothing above it', async () => {
    const f = await fixture()
    const { token } = (await request(app.getHttpServer()).post(`/nodes/${f.legal.id}/shares`).set(f.auth).send({ mode: 'PUBLIC_LINK' })).body

    await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes?parentId=${f.legal.id}`)
      .set({ 'X-Share-Token': token })
      .expect(200)
      .expect((r) => expect(r.body.items.map((i: { name: string }) => i.name)).toEqual(['MSA.pdf']))

    await request(app.getHttpServer()).get(`/rooms/${f.roomId}/nodes?parentId=${f.rootId}`).set({ 'X-Share-Token': token }).expect(404)
  })

  it('grants a named user access by email and shows it under shared-with-me', async () => {
    const f = await fixture()
    await request(app.getHttpServer())
      .post(`/nodes/${f.legal.id}/shares`)
      .set(f.auth)
      .send({ mode: 'USER', email: f.guest.email.toUpperCase() })
      .expect(201)

    const mine = await request(app.getHttpServer()).get('/rooms/shared-with-me').set(f.guestAuth).expect(200)
    expect(mine.body[0]).toMatchObject({ nodeId: f.legal.id, nodeName: 'Legal', isWholeRoom: false })
  })

  it('accepts an invite for an address with no account yet', async () => {
    const f = await fixture()
    const res = await request(app.getHttpServer())
      .post(`/nodes/${f.legal.id}/shares`)
      .set(f.auth)
      .send({ mode: 'USER', email: 'future-hire@example.com' })
      .expect(201)
    expect(res.body.share).toMatchObject({ granteeEmail: 'future-hire@example.com', granteeId: null })
  })

  it('re-inviting the same address updates the existing grant instead of failing', async () => {
    const f = await fixture()
    const first = await request(app.getHttpServer())
      .post(`/nodes/${f.legal.id}/shares`)
      .set(f.auth)
      .send({ mode: 'USER', email: f.guest.email })
      .expect(201)
    await request(app.getHttpServer()).delete(`/shares/${first.body.share.id}`).set(f.auth).expect(200)

    const second = await request(app.getHttpServer())
      .post(`/nodes/${f.legal.id}/shares`)
      .set(f.auth)
      .send({ mode: 'USER', email: f.guest.email })
      .expect(201)
    expect(second.body.share.id).toBe(first.body.share.id)
    expect(second.body.share.revokedAt).toBeNull()
  })

  it('revocation makes the link return 410, not 404', async () => {
    const f = await fixture()
    const created = await request(app.getHttpServer()).post(`/nodes/${f.legal.id}/shares`).set(f.auth).send({ mode: 'PUBLIC_LINK' }).expect(201)
    await request(app.getHttpServer()).delete(`/shares/${created.body.share.id}`).set(f.auth).expect(200)

    await request(app.getHttpServer()).get(`/shared/${created.body.token}`).expect(410)
    await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes?parentId=${f.legal.id}`)
      .set({ 'X-Share-Token': created.body.token })
      .expect(404)
  })

  it('returns 404 for a token that never existed', async () => {
    await request(app.getHttpServer()).get('/shared/definitely-not-a-real-token').expect(404)
  })

  it('returns 410 when the shared node itself was deleted', async () => {
    const f = await fixture()
    const created = await request(app.getHttpServer()).post(`/nodes/${f.legal.id}/shares`).set(f.auth).send({ mode: 'PUBLIC_LINK' }).expect(201)
    await prisma.node.update({ where: { id: f.legal.id }, data: { deletedAt: new Date() } })
    await request(app.getHttpServer()).get(`/shared/${created.body.token}`).expect(410)
  })

  it('refuses share creation from a viewer with 403', async () => {
    const f = await fixture()
    const created = await request(app.getHttpServer()).post(`/nodes/${f.legal.id}/shares`).set(f.auth).send({ mode: 'PUBLIC_LINK' }).expect(201)
    await request(app.getHttpServer())
      .post(`/nodes/${f.msa.id}/shares`)
      .set({ 'X-Share-Token': created.body.token })
      .send({ mode: 'PUBLIC_LINK' })
      .expect(403)
  })

  it('refuses revocation by anyone but the room owner, with 404', async () => {
    const f = await fixture()
    const created = await request(app.getHttpServer()).post(`/nodes/${f.legal.id}/shares`).set(f.auth).send({ mode: 'PUBLIC_LINK' }).expect(201)
    await request(app.getHttpServer()).delete(`/shares/${created.body.share.id}`).set(f.guestAuth).expect(404)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter api test:e2e -- shares`
Expected: FAIL — share routes missing.

- [ ] **Step 3: Implement DTOs and the service**

`apps/api/src/shares/dto/shares.dto.ts`:
```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsEmail, IsIn, IsOptional, ValidateIf } from 'class-validator'

export class CreateShareDto {
  @ApiProperty({ enum: ['PUBLIC_LINK', 'USER'] })
  @IsIn(['PUBLIC_LINK', 'USER'])
  mode: 'PUBLIC_LINK' | 'USER'

  @ApiPropertyOptional({ description: 'Required for mode USER; may be an address with no account yet' })
  @ValidateIf((o: CreateShareDto) => o.mode === 'USER')
  @IsEmail()
  @IsOptional()
  email?: string
}
```

`apps/api/src/shares/shares.service.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import { AppEnv } from '../config/env'
import { AccessContext } from '../access/access-context'
import { NodeRow } from '../access/access.resolver'
import { DomainError, notFound } from '../common/errors'
import { ancestorIds } from '../nodes/node-path'
import { generateShareToken, hashShareToken } from '../access/share-token'
import { CreateShareDto } from './dto/shares.dto'

@Injectable()
export class SharesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  async create(ctx: AccessContext, node: NodeRow, dto: CreateShareDto) {
    if (dto.mode === 'PUBLIC_LINK') {
      const { token, tokenHash } = generateShareToken()
      const share = await this.prisma.share.create({
        data: { nodeId: node.id, mode: 'PUBLIC_LINK', role: 'VIEWER', tokenHash, createdById: ctx.userId! },
      })
      // The only moment the raw token exists outside the client that receives it.
      return { share: this.redact(share), token, url: `${this.config.get('PUBLIC_APP_URL', { infer: true })}/s/${token}` }
    }

    const email = dto.email!.toLowerCase()
    const grantee = await this.prisma.user.findUnique({ where: { email } })
    const share = await this.prisma.share.upsert({
      where: { nodeId_granteeEmail: { nodeId: node.id, granteeEmail: email } },
      create: { nodeId: node.id, mode: 'USER', role: 'VIEWER', granteeEmail: email, granteeId: grantee?.id ?? null, createdById: ctx.userId! },
      update: { revokedAt: null },
    })
    return { share: this.redact(share) }
  }

  async list(_ctx: AccessContext, node: NodeRow) {
    const shares = await this.prisma.share.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: 'desc' } })
    return shares.map((s) => this.redact(s))
  }

  /** Only the room owner may revoke; anyone else is told the share does not exist. */
  async revoke(userId: string, shareId: string) {
    const share = await this.prisma.share.findFirst({
      where: { id: shareId, node: { room: { ownerId: userId } } },
    })
    if (!share) throw notFound()
    const updated = await this.prisma.share.update({ where: { id: share.id }, data: { revokedAt: new Date() } })
    return this.redact(updated)
  }

  /**
   * Guest bootstrap. A token that never existed is 404; a token that did exist but is
   * revoked, or whose target is gone, is 410 — the holder already has the secret, so
   * telling them it stopped working leaks nothing and reads far better.
   */
  async resolveToken(token: string) {
    const share = await this.prisma.share.findUnique({
      where: { tokenHash: hashShareToken(token) },
      include: { node: { include: { room: true } } },
    })
    if (!share) throw notFound()
    if (share.revokedAt) throw new DomainError('GONE', 'This link is no longer active')
    if (share.node.deletedAt) throw new DomainError('GONE', 'This item was deleted by the owner')

    const ancestors = ancestorIds(share.node.path)
    if (ancestors.length) {
      const deleted = await this.prisma.node.findFirst({ where: { id: { in: ancestors }, deletedAt: { not: null } } })
      if (deleted) throw new DomainError('GONE', 'This item was deleted by the owner')
    }

    return {
      role: share.role,
      roomId: share.node.roomId,
      roomName: share.node.room.name,
      node: { id: share.node.id, name: share.node.name, type: share.node.type },
    }
  }

  private redact(share: { id: string; nodeId: string; mode: string; role: string; granteeEmail: string | null; granteeId: string | null; createdAt: Date; revokedAt: Date | null }) {
    return {
      id: share.id,
      nodeId: share.nodeId,
      mode: share.mode,
      role: share.role,
      granteeEmail: share.granteeEmail,
      granteeId: share.granteeId,
      createdAt: share.createdAt,
      revokedAt: share.revokedAt,
      // tokenHash is deliberately never serialized.
    }
  }
}
```

- [ ] **Step 4: Implement the controllers**

`apps/api/src/shares/shares.controller.ts`:
```ts
import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Access, AccessGuard, AccessNode, RequireOwner } from '../access/access.guard'
import { AccessContext } from '../access/access-context'
import { NodeRow } from '../access/access.resolver'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { AuthUser } from '../auth/auth.service'
import { SharesService } from './shares.service'
import { CreateShareDto } from './dto/shares.dto'

@ApiTags('shares')
@ApiBearerAuth('access-token')
@Controller()
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  @Post('nodes/:id/shares')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({ summary: 'Share a Data Room, folder or file (read-only)' })
  @ApiResponse({ status: 201, description: 'For PUBLIC_LINK the raw token is returned once and never again' })
  @ApiResponse({ status: 403, description: 'Read-only access' })
  create(@Access() ctx: AccessContext, @AccessNode() node: NodeRow, @Body() dto: CreateShareDto) {
    return this.shares.create(ctx, node, dto)
  }

  @Get('nodes/:id/shares')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({ summary: 'Shares on this item, including revoked ones' })
  list(@Access() ctx: AccessContext, @AccessNode() node: NodeRow) {
    return this.shares.list(ctx, node)
  }

  @Delete('shares/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Revoke a share' })
  @ApiResponse({ status: 404, description: 'Not found or not owned by the caller' })
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.shares.revoke(user.id, id)
  }
}
```

`DELETE /shares/:id` uses `JwtAuthGuard` rather than `AccessGuard`: the route parameter is a share id, not a node id, so ownership is checked by joining share → node → room inside the service.

`apps/api/src/shares/public-share.controller.ts`:
```ts
import { Controller, Get, Param } from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { SharesService } from './shares.service'

@ApiTags('shares')
@Controller('shared')
export class PublicShareController {
  constructor(private readonly shares: SharesService) {}

  @Get(':token')
  @ApiOperation({ summary: 'Resolve a public link into its target — no authentication required' })
  @ApiResponse({ status: 404, description: 'No such link' })
  @ApiResponse({ status: 410, description: 'Link revoked, or the item was deleted' })
  resolve(@Param('token') token: string) {
    return this.shares.resolveToken(token)
  }
}
```

`apps/api/src/shares/shares.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { AuthModule } from '../auth/auth.module'
import { SharesController } from './shares.controller'
import { PublicShareController } from './public-share.controller'
import { SharesService } from './shares.service'

@Module({
  imports: [AccessModule, AuthModule],
  controllers: [SharesController, PublicShareController],
  providers: [SharesService],
})
export class SharesModule {}
```

Add `SharesModule` to `AppModule.imports`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter api test:e2e -- shares`
Expected: all twelve PASS. The three that encode the spec's judgement calls: a listed share never carries the token or its hash, revocation yields 410 on the bootstrap and 404 on data routes, and an unknown token is 404 while a revoked one is 410.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/shares apps/api/test/shares.e2e-spec.ts apps/api/src/app.module.ts
git commit -m "feat(api): public link and per-user shares with revocation and guest bootstrap"
```

---

### Task 17: Name search, and emitting openapi.json

**Files:**
- Create: `apps/api/src/search/search.service.ts`, `search.controller.ts`, `search.module.ts`
- Create: `apps/api/src/openapi.ts`
- Test: `apps/api/test/search.e2e-spec.ts`

**Interfaces:**
- Consumes: `AccessGuard`, `AccessContext`, `encodeCursor`, `decodeCursor`, `buildSwagger` from Plan 01
- Produces:
  - `SearchService.byName(ctx, q, cursor?, limit?): Promise<{ items; nextCursor }>` where each item carries `parentId`, `parentName` for context
  - `GET /rooms/:roomId/search?q=&parentId=&cursor=&limit=`
  - `pnpm --filter api openapi:emit` writes `apps/api/openapi.json`

- [ ] **Step 1: Write the failing tests**

`apps/api/test/search.e2e-spec.ts`:
```ts
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter'
import { PrismaExceptionFilter } from '../src/common/filters/prisma-exception.filter'
import { BigIntInterceptor } from '../src/common/interceptors/bigint.interceptor'
import { hashShareToken } from '../src/access/share-token'
import { createFile, createFolder, createRoom, createShare, createUser, prisma } from './factories'

describe('search', () => {
  let app: INestApplication

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = mod.createNestApplication()
    app.use(cookieParser())
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    app.useGlobalFilters(new PrismaExceptionFilter(), new DomainExceptionFilter())
    app.useGlobalInterceptors(new BigIntInterceptor())
    await app.init()
  })
  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  async function fixture() {
    const owner = await createUser()
    const token = (await request(app.getHttpServer()).post('/auth/login').send({ email: owner.email, password: owner.password })).body
      .accessToken as string
    const { roomId, rootId, root } = await createRoom(owner.id)
    const legal = await createFolder({ ...root, roomId }, 'Legal', owner.id)
    const financials = await createFolder({ ...root, roomId }, 'Financials', owner.id)
    await createFile(legal, 'Master Services Agreement.pdf', owner.id)
    await createFile(financials, 'FY23 Audit.pdf', owner.id)
    await createFile(financials, 'FY24 Audit.pdf', owner.id)
    return { owner, roomId, rootId, legal, financials, auth: { Authorization: `Bearer ${token}` } }
  }

  it('finds files across the whole room by substring, case-insensitively', async () => {
    const f = await fixture()
    const res = await request(app.getHttpServer()).get(`/rooms/${f.roomId}/search?q=audit`).set(f.auth).expect(200)
    expect(res.body.items.map((i: { name: string }) => i.name).sort()).toEqual(['FY23 Audit.pdf', 'FY24 Audit.pdf'])
  })

  it('returns the containing folder for context', async () => {
    const f = await fixture()
    const res = await request(app.getHttpServer()).get(`/rooms/${f.roomId}/search?q=Master`).set(f.auth).expect(200)
    expect(res.body.items[0]).toMatchObject({ parentId: f.legal.id, parentName: 'Legal', type: 'FILE' })
  })

  it('matches folders as well as files', async () => {
    const f = await fixture()
    const res = await request(app.getHttpServer()).get(`/rooms/${f.roomId}/search?q=financ`).set(f.auth).expect(200)
    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual(['Financials'])
  })

  it('never returns results outside a viewer scope', async () => {
    const f = await fixture()
    const token = 'search-scope-token'
    await createShare({ nodeId: f.legal.id, mode: 'PUBLIC_LINK', createdById: f.owner.id, tokenHash: hashShareToken(token) })

    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/search?q=audit&parentId=${f.legal.id}`)
      .set({ 'X-Share-Token': token })
      .expect(200)
    expect(res.body.items).toEqual([])

    const inScope = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/search?q=master&parentId=${f.legal.id}`)
      .set({ 'X-Share-Token': token })
      .expect(200)
    expect(inScope.body.items).toHaveLength(1)
  })

  it('excludes deleted and PENDING nodes', async () => {
    const f = await fixture()
    const deleted = await createFile(f.financials, 'FY22 Audit.pdf', f.owner.id)
    await prisma.node.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } })
    await prisma.node.create({
      data: { roomId: f.roomId, parentId: f.financials.id, type: 'FILE', name: 'FY21 Audit.pdf', path: `/${f.rootId}/${f.financials.id}/`, status: 'PENDING', createdById: f.owner.id },
    })

    const res = await request(app.getHttpServer()).get(`/rooms/${f.roomId}/search?q=audit`).set(f.auth).expect(200)
    expect(res.body.items.map((i: { name: string }) => i.name).sort()).toEqual(['FY23 Audit.pdf', 'FY24 Audit.pdf'])
  })

  it('rejects a query shorter than two characters with 422', async () => {
    const f = await fixture()
    await request(app.getHttpServer()).get(`/rooms/${f.roomId}/search?q=a`).set(f.auth).expect(422)
  })

  it('treats a percent sign as a literal, not a wildcard', async () => {
    const f = await fixture()
    await createFile(f.financials, 'Margin 20% FY24.pdf', f.owner.id)
    const res = await request(app.getHttpServer()).get(`/rooms/${f.roomId}/search?q=${encodeURIComponent('20%')}`).set(f.auth).expect(200)
    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual(['Margin 20% FY24.pdf'])
  })

  it('paginates results', async () => {
    const f = await fixture()
    const first = await request(app.getHttpServer()).get(`/rooms/${f.roomId}/search?q=audit&limit=1`).set(f.auth).expect(200)
    expect(first.body.items).toHaveLength(1)
    expect(first.body.nextCursor).toBeTruthy()

    const second = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/search?q=audit&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set(f.auth)
      .expect(200)
    expect(second.body.items[0].name).not.toBe(first.body.items[0].name)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter api test:e2e -- search`
Expected: FAIL — 404 on the search route.

- [ ] **Step 3: Implement the service**

`apps/api/src/search/search.service.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { AccessContext } from '../access/access-context'
import { decodeCursor, encodeCursor } from '../nodes/cursor'

export type SearchHit = {
  id: string
  name: string
  type: 'FOLDER' | 'FILE'
  sizeBytes: bigint | null
  updatedAt: Date
  parentId: string | null
  parentName: string | null
}

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Uses the pg_trgm GIN index on name. Scope is applied in SQL — a viewer's search
   * cannot reach outside the subtree that was shared with them — and the keyset
   * predicate is part of the query rather than a post-filter, so LIMIT stays honest.
   */
  async byName(ctx: AccessContext, q: string, opts: { cursor?: string; limit: number }) {
    // LIKE metacharacters are escaped so a query of "20%" matches the literal string.
    const needle = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
    const keyset = cursor ? Prisma.sql`AND (sort_key, id) > (${cursor.key}, ${cursor.id})` : Prisma.empty

    const rows = await this.prisma.$queryRaw<(SearchHit & { sort_key: string })[]>`
      WITH scoped AS (
        SELECT n.id, n.name, n.type, n."sizeBytes", n."updatedAt", n."parentId",
               p.name AS "parentName",
               lower(n.name) AS sort_key
        FROM "Node" n
        LEFT JOIN "Node" p ON p.id = n."parentId"
        WHERE n."roomId" = ${ctx.roomId}
          AND (n.id = ${ctx.scopeRootId} OR n.path LIKE ${ctx.scopePath} || '%')
          AND n.id <> ${ctx.scopeRootId}
          AND n."deletedAt" IS NULL
          AND n.status = 'ACTIVE'
          AND n.name ILIKE ${needle}
      )
      SELECT * FROM scoped WHERE TRUE ${keyset}
      ORDER BY sort_key ASC, id ASC
      LIMIT ${opts.limit + 1}`

    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    const last = page[page.length - 1]

    return {
      items: page.map(({ sort_key, ...hit }) => hit as SearchHit),
      nextCursor: hasMore && last ? encodeCursor({ key: last.sort_key, id: last.id }) : null,
    }
  }
}
```

The scope root itself is excluded from results: matching the folder you are already inside is noise, not a hit.

`apps/api/src/search/search.controller.ts`:
```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger'
import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator'
import { Type } from 'class-transformer'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Access, AccessGuard } from '../access/access.guard'
import { AccessContext } from '../access/access-context'
import { SearchService } from './search.service'

export class SearchQueryDto {
  @ApiProperty({ minLength: 2, example: 'audit' })
  @IsString()
  @MinLength(2)
  q: string

  @ApiPropertyOptional({ description: 'Scope root for a share viewer; ignored for owners' })
  @IsOptional()
  @IsString()
  parentId?: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cursor?: string

  @ApiPropertyOptional({ default: 25, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number
}

@ApiTags('search')
@ApiBearerAuth('access-token')
@ApiSecurity('share-token')
@Controller('rooms/:roomId/search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @UseGuards(AccessGuard)
  @ApiOperation({ summary: 'Find folders and files by name inside the caller scope' })
  find(@Access() ctx: AccessContext, @Query() query: SearchQueryDto) {
    return this.search.byName(ctx, query.q, { cursor: query.cursor, limit: query.limit ?? 25 })
  }
}
```

`apps/api/src/search/search.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { SearchController } from './search.controller'
import { SearchService } from './search.service'

@Module({ imports: [AccessModule], controllers: [SearchController], providers: [SearchService] })
export class SearchModule {}
```

Add `SearchModule` to `AppModule.imports`.

- [ ] **Step 4: Emit openapi.json**

`apps/api/src/openapi.ts`:
```ts
import 'reflect-metadata'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { SwaggerModule } from '@nestjs/swagger'
import { AppModule } from './app.module'
import { buildSwagger } from './swagger'

/**
 * Emits the contract the frontend generates its types from. Run in CI so a DTO change
 * that the frontend has not adopted fails the build rather than production.
 */
async function emit() {
  const app = await NestFactory.create(AppModule, { logger: false })
  const document = SwaggerModule.createDocument(app, buildSwagger())
  writeFileSync(join(__dirname, '..', 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`)
  await app.close()
  process.stdout.write('openapi.json written\n')
}
void emit()
```

- [ ] **Step 5: Run the tests and emit the contract**

Run:
```bash
pnpm --filter api test:e2e -- search
pnpm --filter api openapi:emit
node -e "const d=require('./apps/api/openapi.json');console.log(Object.keys(d.paths).length,'paths')"
```
Expected: search tests PASS; `openapi.json` lists every route from Plans 01–03 (auth, rooms, nodes, uploads, files, shares, search, health).

- [ ] **Step 6: Run the whole API suite once**

Run: `pnpm --filter api test && pnpm --filter api test:e2e`
Expected: everything green. This is the gate before any frontend work starts.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/search apps/api/src/openapi.ts apps/api/test/search.e2e-spec.ts apps/api/src/app.module.ts
git commit -m "feat(api): scoped trigram name search and openapi.json emission"
```
