# Data Room — Plan 02: Tree API and Authorization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan set:** this is one of six. Order: 01 foundation → 02 tree API → 03 files & sharing API → 04 web shell → 05 web browser → 06 sharing UI & release. See `2026-08-19-data-room-00-overview.md`.

**Goal:** Build the folder tree — rooms, listing, breadcrumbs, create, rename, move, delete — on top of one access decision that no route can bypass.

**Architecture:** A materialized `path` string turns every subtree operation into a prefix scan. `AccessResolver` produces one `AccessContext` per request; every node read applies its scope prefix in SQL, so reading outside a granted subtree is impossible by construction. Move and delete are single-statement subtree rewrites inside locked transactions.

**Tech Stack:** NestJS 10, Prisma 5 raw SQL for prefix and keyset queries, PostgreSQL partial unique + varchar_pattern_ops indexes, Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-08-19-data-room-design.md`

**Prerequisite:** Plan 01 complete — schema migrated, auth working, `DomainError` contract in place.

**Done when:** An owner can create rooms and folders, list them with breadcrumbs and keyset pagination, rename, move, and delete with a preview; a share viewer is scoped to their subtree and gets 404 outside it, 403 on writes, 410 under a deleted ancestor. All e2e specs green.

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

### Task 7: Pure tree primitives — path, cursor, name conflict

These are the three pieces of arithmetic the whole tree rests on. They are pure functions with no database, so they get exhaustive unit tests and every later task imports them instead of re-deriving string math inline.

**Files:**
- Create: `apps/api/src/nodes/node-path.ts`, `apps/api/src/nodes/cursor.ts`, `apps/api/src/nodes/name-conflict.ts`
- Test: `apps/api/src/nodes/node-path.spec.ts`, `cursor.spec.ts`, `name-conflict.spec.ts`

**Interfaces:**
- Consumes: `DomainError` from Task 2
- Produces:
  - `ROOT_PATH = '/'`
  - `childPath(parent: { id: string; path: string }): string`
  - `ancestorIds(path: string): string[]`
  - `isWithinSubtree(node: { id: string; path: string }, subtreeRootId: string, subtreeRootPath: string): boolean`
  - `encodeCursor(c: { key: string; id: string }): string` / `decodeCursor(raw: string): { key: string; id: string }` — `key` is the stringified value of whichever column the listing is sorted by, so one cursor shape serves all sort modes
  - `resolveAvailableName(desired: string, takenLowercased: Set<string>): string`

- [ ] **Step 1: Write the failing tests**

`apps/api/src/nodes/node-path.spec.ts`:
```ts
import { ancestorIds, childPath, isWithinSubtree, ROOT_PATH } from './node-path'

const ROOT = 'aaaaaaaa-0000-0000-0000-000000000001'
const FIN = 'bbbbbbbb-0000-0000-0000-000000000002'
const FY23 = 'cccccccc-0000-0000-0000-000000000003'

describe('childPath', () => {
  it('builds a root node child path', () => {
    expect(childPath({ id: ROOT, path: ROOT_PATH })).toBe(`/${ROOT}/`)
  })

  it('appends to a nested path', () => {
    expect(childPath({ id: FIN, path: `/${ROOT}/` })).toBe(`/${ROOT}/${FIN}/`)
  })
})

describe('ancestorIds', () => {
  it('returns an empty list for a root node', () => {
    expect(ancestorIds(ROOT_PATH)).toEqual([])
  })

  it('returns ancestors root-first', () => {
    expect(ancestorIds(`/${ROOT}/${FIN}/`)).toEqual([ROOT, FIN])
  })
})

describe('isWithinSubtree', () => {
  const subtreeRootPath = `/${ROOT}/`

  it('accepts the subtree root itself', () => {
    expect(isWithinSubtree({ id: FIN, path: subtreeRootPath }, FIN, subtreeRootPath)).toBe(true)
  })

  it('accepts a descendant', () => {
    expect(isWithinSubtree({ id: FY23, path: `/${ROOT}/${FIN}/` }, FIN, subtreeRootPath)).toBe(true)
  })

  it('rejects a sibling', () => {
    const sibling = 'dddddddd-0000-0000-0000-000000000004'
    expect(isWithinSubtree({ id: sibling, path: `/${ROOT}/` }, FIN, subtreeRootPath)).toBe(false)
  })

  it('rejects an ancestor', () => {
    expect(isWithinSubtree({ id: ROOT, path: ROOT_PATH }, FIN, subtreeRootPath)).toBe(false)
  })
})
```

`apps/api/src/nodes/cursor.spec.ts`:
```ts
import { decodeCursor, encodeCursor } from './cursor'
import { DomainError } from '../common/errors'

describe('keyset cursor', () => {
  it('round-trips a sort key and id', () => {
    const c = { key: 'FY23 Report.pdf', id: 'abc-123' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('survives keys containing separators and unicode', () => {
    const c = { key: 'a/b:c—ü.pdf', id: 'id-1' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('round-trips an ISO timestamp key, so date sorting shares one cursor shape', () => {
    const c = { key: '2026-08-19T10:00:00.000Z', id: 'id-2' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('rejects a malformed cursor with VALIDATION rather than crashing', () => {
    expect(() => decodeCursor('not-base64!!')).toThrow(DomainError)
    expect(() => decodeCursor(Buffer.from('no-separator').toString('base64url'))).toThrow(DomainError)
  })
})
```

`apps/api/src/nodes/name-conflict.spec.ts`:
```ts
import { resolveAvailableName } from './name-conflict'

const taken = (...names: string[]) => new Set(names.map((n) => n.toLowerCase()))

describe('resolveAvailableName', () => {
  it('returns the desired name when free', () => {
    expect(resolveAvailableName('invoice.pdf', taken())).toBe('invoice.pdf')
  })

  it('appends (2) before the extension', () => {
    expect(resolveAvailableName('invoice.pdf', taken('invoice.pdf'))).toBe('invoice (2).pdf')
  })

  it('skips suffixes that are already taken', () => {
    expect(resolveAvailableName('invoice.pdf', taken('invoice.pdf', 'invoice (2).pdf', 'invoice (3).pdf'))).toBe('invoice (4).pdf')
  })

  it('is case-insensitive, matching the database index', () => {
    expect(resolveAvailableName('Invoice.PDF', taken('invoice.pdf'))).toBe('Invoice (2).PDF')
  })

  it('handles a name with no extension', () => {
    expect(resolveAvailableName('Board Minutes', taken('board minutes'))).toBe('Board Minutes (2)')
  })

  it('only splits on the final dot', () => {
    expect(resolveAvailableName('2023.Q4.pdf', taken('2023.q4.pdf'))).toBe('2023.Q4 (2).pdf')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter api test -- nodes/`
Expected: FAIL — `Cannot find module './node-path'` and the two siblings.

- [ ] **Step 3: Implement the three modules**

`apps/api/src/nodes/node-path.ts`:
```ts
/**
 * A node's `path` holds its ancestors' ids, root first, each delimited and
 * terminated by '/'. A root node's path is exactly '/'.
 *
 *   root        -> "/"
 *   root/fin    -> "/{rootId}/"
 *   root/fin/q4 -> "/{rootId}/{finId}/"
 *
 * The trailing slash is what makes prefix matching safe: ids are fixed length and
 * the delimiter closes the prefix, so "/a/ab/" can never match "/a/abc/".
 */
export const ROOT_PATH = '/'

export function childPath(parent: { id: string; path: string }): string {
  return `${parent.path}${parent.id}/`
}

export function ancestorIds(path: string): string[] {
  return path.split('/').filter(Boolean)
}

export function depth(path: string): number {
  return ancestorIds(path).length
}

/** True when `node` is the subtree root itself or lives anywhere beneath it. */
export function isWithinSubtree(
  node: { id: string; path: string },
  subtreeRootId: string,
  subtreeRootPath: string,
): boolean {
  if (node.id === subtreeRootId) return true
  return node.path.startsWith(`${subtreeRootPath}${subtreeRootId}/`)
}

/** SQL LIKE pattern matching every descendant of the given node. */
export function subtreeLikePattern(node: { id: string; path: string }): string {
  return `${childPath(node)}%`
}
```

`apps/api/src/nodes/cursor.ts`:
```ts
import { DomainError } from '../common/errors'

// Escaped, not a literal control character: a raw NUL would make the file binary to grep.
const SEP = '\u0000'

/**
 * Keyset pagination cursor over the (sortKey, id) ordering of a single folder.
 * `key` holds the stringified sort column - a name, an ISO timestamp, or a
 * zero-padded size - so every sort mode shares one cursor shape.
 */
export function encodeCursor(cursor: { key: string; id: string }): string {
  return Buffer.from(`${cursor.key}${SEP}${cursor.id}`, 'utf8').toString('base64url')
}

export function decodeCursor(raw: string): { key: string; id: string } {
  let decoded: string
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    throw new DomainError('VALIDATION', 'Malformed cursor')
  }
  const idx = decoded.lastIndexOf(SEP)
  if (idx <= 0 || idx === decoded.length - 1) throw new DomainError('VALIDATION', 'Malformed cursor')
  return { key: decoded.slice(0, idx), id: decoded.slice(idx + 1) }
}
```

`apps/api/src/nodes/name-conflict.ts`:
```ts
function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return [name, '']
  return [name.slice(0, dot), name.slice(dot)]
}

/**
 * Produces "invoice (2).pdf" for the KEEP_BOTH upload strategy.
 * `takenLowercased` must be lower-cased by the caller because the database index
 * is on lower(name) — comparing case-sensitively here would generate a name the
 * insert then rejects.
 */
export function resolveAvailableName(desired: string, takenLowercased: Set<string>): string {
  if (!takenLowercased.has(desired.toLowerCase())) return desired
  const [stem, ext] = splitExtension(desired)
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!takenLowercased.has(candidate.toLowerCase())) return candidate
  }
  throw new Error(`Could not find a free name for ${desired}`)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter api test -- nodes/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/nodes
git commit -m "feat(api): pure path, cursor and name-conflict primitives"
```

---

### Task 8: Rooms with their root node, plus the subtree rollup

**Files:**
- Create: `apps/api/src/rooms/rooms.module.ts`, `rooms.service.ts`, `rooms.controller.ts`, `dto/room.dto.ts`
- Create: `apps/api/src/nodes/rollup.service.ts`
- Create: `apps/api/test/factories.ts`
- Test: `apps/api/test/rooms.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `JwtAuthGuard`, `CurrentUser`, `childPath`, `ROOT_PATH`
- Produces:
  - `RollupService.forSubtree(roomId: string, node: { id: string; path: string }): Promise<{ folders: number; files: number; bytes: number }>`
  - `RoomsService.create`, `.listOwned`, `.rename`, `.remove`, `.listSharedWithMe`
  - `POST /rooms`, `GET /rooms`, `PATCH /rooms/:id`, `DELETE /rooms/:id`, `GET /rooms/shared-with-me`
  - `test/factories.ts`: `createUser`, `createRoom`, `createFolder`, `createFile`, `createShare` — reused by every later e2e test

- [ ] **Step 1: Write the failing tests**

`apps/api/test/factories.ts`:
```ts
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client'
import { NodeType } from '../src/generated/prisma/enums'
import { randomUUID } from 'node:crypto'
import * as argon2 from 'argon2'
import { childPath, ROOT_PATH } from '../src/nodes/node-path'

export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) })

export async function createUser(password = 'password123') {
  const email = `u-${randomUUID()}@test.io`
  const user = await prisma.user.create({ data: { email, name: 'Test User', passwordHash: await argon2.hash(password) } })
  return { ...user, password }
}

export async function createRoom(ownerId: string, name = 'Project Titan') {
  const roomId = randomUUID()
  const rootId = randomUUID()
  // DataRoom first: Node.roomId is a foreign key to it. rootNodeId is only unique,
  // not a foreign key, so it can name a row that does not exist yet.
  await prisma.dataRoom.create({ data: { id: roomId, ownerId, name, rootNodeId: rootId } })
  const root = await prisma.node.create({
    data: { id: rootId, roomId, parentId: null, type: 'FOLDER', name, path: ROOT_PATH, status: 'ACTIVE', createdById: ownerId },
  })
  return { roomId, rootId, root }
}

export async function createFolder(parent: { id: string; path: string; roomId: string }, name: string, createdById: string) {
  return prisma.node.create({
    data: { roomId: parent.roomId, parentId: parent.id, type: 'FOLDER', name, path: childPath(parent), status: 'ACTIVE', createdById },
  })
}

export async function createFile(
  parent: { id: string; path: string; roomId: string },
  name: string,
  createdById: string,
  sizeBytes = 1024,
) {
  const node = await prisma.node.create({
    data: {
      roomId: parent.roomId,
      parentId: parent.id,
      type: NodeType.FILE,
      name,
      path: childPath(parent),
      status: 'ACTIVE',
      sizeBytes: BigInt(sizeBytes),
      createdById,
    },
  })
  const version = await prisma.fileVersion.create({
    data: {
      nodeId: node.id,
      versionNo: 1,
      blobKey: `rooms/${parent.roomId}/nodes/${node.id}/v1`,
      sizeBytes: BigInt(sizeBytes),
      mimeType: 'application/pdf',
      createdById,
    },
  })
  return prisma.node.update({ where: { id: node.id }, data: { currentVersionId: version.id } })
}

export async function createShare(input: {
  nodeId: string
  mode: 'PUBLIC_LINK' | 'USER'
  createdById: string
  tokenHash?: string
  granteeEmail?: string
}) {
  return prisma.share.create({ data: { ...input, role: 'VIEWER' } })
}
```

`apps/api/test/rooms.e2e-spec.ts`:
```ts
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import cookieParser from 'cookie-parser'
import { AppModule } from '../src/app.module'
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter'
import { PrismaExceptionFilter } from '../src/common/filters/prisma-exception.filter'
import { BigIntInterceptor } from '../src/common/interceptors/bigint.interceptor'
import { createFile, createFolder, createUser, prisma } from './factories'

describe('rooms', () => {
  let app: INestApplication
  let token: string
  let userId: string

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = mod.createNestApplication()
    app.use(cookieParser())
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    app.useGlobalFilters(new PrismaExceptionFilter(), new DomainExceptionFilter())
    app.useGlobalInterceptors(new BigIntInterceptor())
    await app.init()

    const user = await createUser()
    userId = user.id
    const res = await request(app.getHttpServer()).post('/auth/login').send({ email: user.email, password: user.password })
    token = res.body.accessToken
  })
  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const auth = () => ({ Authorization: `Bearer ${token}` })

  it('creates a room together with its root node', async () => {
    const res = await request(app.getHttpServer()).post('/rooms').set(auth()).send({ name: 'Project Titan' }).expect(201)
    expect(res.body).toMatchObject({ name: 'Project Titan' })
    const root = await prisma.node.findUniqueOrThrow({ where: { id: res.body.rootNodeId } })
    expect(root).toMatchObject({ parentId: null, path: '/', type: 'FOLDER', status: 'ACTIVE', name: 'Project Titan' })
  })

  it('lists only rooms owned by the caller, with a rollup', async () => {
    const created = await request(app.getHttpServer()).post('/rooms').set(auth()).send({ name: 'With Content' }).expect(201)
    const root = await prisma.node.findUniqueOrThrow({ where: { id: created.body.rootNodeId } })
    const sub = await createFolder(root, 'Financials', userId)
    await createFile(sub, 'a.pdf', userId, 2048)
    await createFile(root, 'b.pdf', userId, 1024)

    const otherUser = await createUser()
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: otherUser.email, password: otherUser.password })
      .then((r) => request(app.getHttpServer()).post('/rooms').set({ Authorization: `Bearer ${r.body.accessToken}` }).send({ name: 'Not Mine' }))

    const list = await request(app.getHttpServer()).get('/rooms').set(auth()).expect(200)
    const names = list.body.map((r: { name: string }) => r.name)
    expect(names).toContain('With Content')
    expect(names).not.toContain('Not Mine')

    const row = list.body.find((r: { name: string }) => r.name === 'With Content')
    expect(row.rollup).toEqual({ folders: 1, files: 2, bytes: 3072 })
  })

  it('renames the room and its root node together', async () => {
    const created = await request(app.getHttpServer()).post('/rooms').set(auth()).send({ name: 'Old' }).expect(201)
    await request(app.getHttpServer()).patch(`/rooms/${created.body.id}`).set(auth()).send({ name: 'New' }).expect(200)
    const root = await prisma.node.findUniqueOrThrow({ where: { id: created.body.rootNodeId } })
    expect(root.name).toBe('New')
  })

  it('returns 404 when renaming someone else’s room', async () => {
    const stranger = await createUser()
    const strangerToken = (
      await request(app.getHttpServer()).post('/auth/login').send({ email: stranger.email, password: stranger.password })
    ).body.accessToken
    const mine = await request(app.getHttpServer()).post('/rooms').set(auth()).send({ name: 'Private' }).expect(201)

    await request(app.getHttpServer())
      .patch(`/rooms/${mine.body.id}`)
      .set({ Authorization: `Bearer ${strangerToken}` })
      .send({ name: 'Hijacked' })
      .expect(404)
  })

  it('rejects an empty room name with 400', async () => {
    await request(app.getHttpServer()).post('/rooms').set(auth()).send({ name: '' }).expect(400)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter api test:e2e -- rooms`
Expected: FAIL — 404 on `POST /rooms`.

- [ ] **Step 3: Implement the rollup**

`apps/api/src/nodes/rollup.service.ts`:
```ts
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
  async forSubtree(roomId: string, node: { id: string; path: string }): Promise<Rollup> {
    const [row] = await this.prisma.$queryRaw<{ folders: bigint; files: bigint; bytes: bigint }[]>`
      SELECT count(*) FILTER (WHERE type = 'FOLDER')             AS folders,
             count(*) FILTER (WHERE type = 'FILE')               AS files,
             coalesce(sum("sizeBytes") FILTER (WHERE type = 'FILE'), 0) AS bytes
      FROM "Node"
      WHERE "roomId" = ${roomId}
        AND path LIKE ${subtreeLikePattern(node)}
        AND "deletedAt" IS NULL
        AND status = 'ACTIVE'`
    return { folders: Number(row.folders), files: Number(row.files), bytes: Number(row.bytes) }
  }
}
```

- [ ] **Step 4: Implement rooms**

`apps/api/src/rooms/dto/room.dto.ts`:
```ts
import { ApiProperty } from '@nestjs/swagger'
import { IsString, MaxLength, MinLength } from 'class-validator'

export class CreateRoomDto {
  @ApiProperty({ example: 'Project Titan — Acme Acquisition' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string
}

export class RenameRoomDto extends CreateRoomDto {}
```

`apps/api/src/rooms/rooms.service.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { DomainError, notFound } from '../common/errors'
import { ROOT_PATH } from '../nodes/node-path'
import { RollupService } from '../nodes/rollup.service'

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rollup: RollupService,
  ) {}

  /** Room and root node are created together — a room without a root node has no valid share target. */
  async create(ownerId: string, name: string) {
    const roomId = randomUUID()
    const rootNodeId = randomUUID()
    return this.prisma.$transaction(async (tx) => {
      const room = await tx.dataRoom.create({ data: { id: roomId, ownerId, name, rootNodeId } })
      await tx.node.create({
        data: { id: rootNodeId, roomId, parentId: null, type: 'FOLDER', name, path: ROOT_PATH, status: 'ACTIVE', createdById: ownerId },
      })
      return room
    })
  }

  async listOwned(ownerId: string) {
    const rooms = await this.prisma.dataRoom.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' } })
    return Promise.all(
      rooms.map(async (room) => ({
        ...room,
        rollup: await this.rollup.forSubtree(room.id, { id: room.rootNodeId, path: ROOT_PATH }),
      })),
    )
  }

  async findOwned(ownerId: string, roomId: string) {
    const room = await this.prisma.dataRoom.findFirst({ where: { id: roomId, ownerId } })
    if (!room) throw notFound()
    return room
  }

  async rename(ownerId: string, roomId: string, name: string) {
    const room = await this.findOwned(ownerId, roomId)
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.dataRoom.update({ where: { id: room.id }, data: { name } })
      await tx.node.update({ where: { id: room.rootNodeId }, data: { name } })
      return updated
    })
  }

  async remove(ownerId: string, roomId: string) {
    const room = await this.findOwned(ownerId, roomId)
    await this.prisma.dataRoom.delete({ where: { id: room.id } })
    return { id: room.id }
  }

  /** Rooms reachable through a live share granted to this email, deduplicated by room. */
  async listSharedWithMe(email: string) {
    const shares = await this.prisma.share.findMany({
      where: { mode: 'USER', granteeEmail: email.toLowerCase(), revokedAt: null, node: { deletedAt: null } },
      include: { node: { include: { room: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return shares.map((s) => ({
      shareId: s.id,
      role: s.role,
      roomId: s.node.roomId,
      roomName: s.node.room.name,
      nodeId: s.nodeId,
      nodeName: s.node.name,
      nodeType: s.node.type,
      isWholeRoom: s.nodeId === s.node.room.rootNodeId,
    }))
  }
}
```

Note `listSharedWithMe` filters on the shared node's own `deletedAt`; the ancestor tombstone case is handled by `AccessResolver` in Task 9, which is where the 410 belongs.

`apps/api/src/rooms/rooms.controller.ts`:
```ts
import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { AuthUser } from '../auth/auth.service'
import { RoomsService } from './rooms.service'
import { CreateRoomDto, RenameRoomDto } from './dto/room.dto'

@ApiTags('rooms')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a Data Room and its root folder' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRoomDto) {
    return this.rooms.create(user.id, dto.name)
  }

  @Get()
  @ApiOperation({ summary: 'List owned Data Rooms with subtree totals' })
  list(@CurrentUser() user: AuthUser) {
    return this.rooms.listOwned(user.id)
  }

  @Get('shared-with-me')
  @ApiOperation({ summary: 'Items shared with the signed-in user' })
  sharedWithMe(@CurrentUser() user: AuthUser) {
    return this.rooms.listSharedWithMe(user.email)
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a Data Room and its root folder' })
  @ApiResponse({ status: 404, description: 'Not found or not owned by the caller' })
  rename(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RenameRoomDto) {
    return this.rooms.rename(user.id, id, dto.name)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a Data Room and everything in it' })
  @ApiResponse({ status: 404, description: 'Not found or not owned by the caller' })
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.rooms.remove(user.id, id)
  }
}
```

`GET /rooms/shared-with-me` is declared before `PATCH /:id` in the file, but the two use different verbs so ordering is not load-bearing here. It is still declared above the parameterised routes to keep the reading order obvious.

`apps/api/src/rooms/rooms.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { RoomsService } from './rooms.service'
import { RoomsController } from './rooms.controller'
import { RollupService } from '../nodes/rollup.service'

@Module({
  controllers: [RoomsController],
  providers: [RoomsService, RollupService],
  exports: [RoomsService, RollupService],
})
export class RoomsModule {}
```

Add `RoomsModule` to `AppModule.imports`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter api test:e2e -- rooms`
Expected: all PASS. The rollup assertion `{ folders: 1, files: 2, bytes: 3072 }` proves the aggregate counts the whole subtree, not just direct children.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/rooms apps/api/src/nodes/rollup.service.ts apps/api/test
git commit -m "feat(api): data rooms with root node and subtree rollup"
```

---

### Task 9: AccessResolver — the single authorization decision

The most expensive possible bug in this application is one owner reading another's Data Room. This task exists to make that decision happen in exactly one place, driven by one query, and to pin the behaviour down with tests before anything depends on it.

**Files:**
- Create: `apps/api/src/access/access-context.ts`, `share-token.ts`, `access.resolver.ts`, `access.guard.ts`, `access.module.ts`
- Test: `apps/api/src/access/share-token.spec.ts`, `apps/api/test/access.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `ancestorIds`, `childPath`, `notFound`, `DomainError`
- Produces:
  - `AccessContext = { role: 'OWNER' | 'VIEWER'; roomId: string; scopeRootId: string; scopePath: string; userId?: string; shareToken?: string; viaShareId?: string }`
    where `scopePath` is the *child prefix* of the scope root, i.e. `childPath(scopeRoot)`
  - `generateShareToken(): { token: string; tokenHash: string }`, `hashShareToken(token: string): string`
  - `AccessResolver.forNode(input: { nodeId: string; user?: AuthUser; shareToken?: string }): Promise<{ ctx: AccessContext; node: NodeRow }>`
  - `AccessResolver.forRoom(input: { roomId: string; user?: AuthUser; shareToken?: string }): Promise<{ ctx: AccessContext; node: NodeRow }>`
  - `AccessGuard` + `@Access() ctx: AccessContext` decorator, `@RequireOwner()` marker

- [ ] **Step 1: Write the failing tests**

`apps/api/src/access/share-token.spec.ts`:
```ts
import { generateShareToken, hashShareToken } from './share-token'

describe('share tokens', () => {
  it('generates a url-safe token and a matching hash', () => {
    const { token, tokenHash } = generateShareToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(tokenHash).toBe(hashShareToken(token))
  })

  it('hashes deterministically, so lookup by hash is a single indexed query', () => {
    expect(hashShareToken('abc')).toBe(hashShareToken('abc'))
    expect(hashShareToken('abc')).not.toBe(hashShareToken('abd'))
  })

  it('never returns the raw token from the hash', () => {
    const { token, tokenHash } = generateShareToken()
    expect(tokenHash).not.toContain(token)
  })
})
```

`apps/api/test/access.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing'
import { AppModule } from '../src/app.module'
import { AccessResolver } from '../src/access/access.resolver'
import { DomainError } from '../src/common/errors'
import { hashShareToken } from '../src/access/share-token'
import { createFile, createFolder, createRoom, createShare, createUser, prisma } from './factories'
import { childPath } from '../src/nodes/node-path'

describe('AccessResolver', () => {
  let resolver: AccessResolver

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    resolver = mod.get(AccessResolver)
  })
  afterAll(() => prisma.$disconnect())

  async function fixture() {
    const owner = await createUser()
    const guest = await createUser()
    const { roomId, rootId, root } = await createRoom(owner.id)
    const legal = await createFolder({ ...root, roomId }, 'Legal', owner.id)
    const contracts = await createFolder(legal, 'Contracts', owner.id)
    const msa = await createFile(contracts, 'MSA.pdf', owner.id)
    const financials = await createFolder({ ...root, roomId }, 'Financials', owner.id)
    return { owner, guest, roomId, rootId, root, legal, contracts, msa, financials }
  }

  const authUser = (u: { id: string; email: string; name: string }) => ({ id: u.id, email: u.email, name: u.name })

  it('gives the owner OWNER role scoped to the room root', async () => {
    const f = await fixture()
    const { ctx } = await resolver.forNode({ nodeId: f.msa.id, user: authUser(f.owner) })
    expect(ctx.role).toBe('OWNER')
    expect(ctx.scopeRootId).toBe(f.rootId)
  })

  it('returns 404, not 403, for a stranger — existence must not leak', async () => {
    const f = await fixture()
    await expect(resolver.forNode({ nodeId: f.msa.id, user: authUser(f.guest) })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('grants VIEWER through a USER share on an ancestor, scoped to that ancestor', async () => {
    const f = await fixture()
    await createShare({ nodeId: f.legal.id, mode: 'USER', createdById: f.owner.id, granteeEmail: f.guest.email })

    const { ctx } = await resolver.forNode({ nodeId: f.msa.id, user: authUser(f.guest) })
    expect(ctx.role).toBe('VIEWER')
    expect(ctx.scopeRootId).toBe(f.legal.id)
    expect(ctx.scopePath).toBe(childPath(f.legal))
  })

  it('does not let a scoped viewer reach a sibling subtree', async () => {
    const f = await fixture()
    await createShare({ nodeId: f.legal.id, mode: 'USER', createdById: f.owner.id, granteeEmail: f.guest.email })
    await expect(resolver.forNode({ nodeId: f.financials.id, user: authUser(f.guest) })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('does not let a scoped viewer reach the room root above the share', async () => {
    const f = await fixture()
    await createShare({ nodeId: f.legal.id, mode: 'USER', createdById: f.owner.id, granteeEmail: f.guest.email })
    await expect(resolver.forNode({ nodeId: f.rootId, user: authUser(f.guest) })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('grants VIEWER through a public link with no signed-in user', async () => {
    const f = await fixture()
    const token = 'public-token-fixture'
    await createShare({ nodeId: f.contracts.id, mode: 'PUBLIC_LINK', createdById: f.owner.id, tokenHash: hashShareToken(token) })

    const { ctx } = await resolver.forNode({ nodeId: f.msa.id, shareToken: token })
    expect(ctx.role).toBe('VIEWER')
    expect(ctx.scopeRootId).toBe(f.contracts.id)
  })

  it('rejects a revoked share', async () => {
    const f = await fixture()
    const token = 'revoked-token-fixture'
    const share = await createShare({ nodeId: f.legal.id, mode: 'PUBLIC_LINK', createdById: f.owner.id, tokenHash: hashShareToken(token) })
    await prisma.share.update({ where: { id: share.id }, data: { revokedAt: new Date() } })
    await expect(resolver.forNode({ nodeId: f.msa.id, shareToken: token })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns GONE when an ancestor was deleted under a guest', async () => {
    const f = await fixture()
    await createShare({ nodeId: f.legal.id, mode: 'USER', createdById: f.owner.id, granteeEmail: f.guest.email })
    await prisma.node.update({ where: { id: f.contracts.id }, data: { deletedAt: new Date() } })
    await expect(resolver.forNode({ nodeId: f.msa.id, user: authUser(f.guest) })).rejects.toMatchObject({ code: 'GONE' })
  })

  it('returns GONE for the owner too when the node itself is deleted', async () => {
    const f = await fixture()
    await prisma.node.update({ where: { id: f.msa.id }, data: { deletedAt: new Date() } })
    await expect(resolver.forNode({ nodeId: f.msa.id, user: authUser(f.owner) })).rejects.toMatchObject({ code: 'GONE' })
  })

  it('prefers the deepest grant when two shares overlap', async () => {
    const f = await fixture()
    await createShare({ nodeId: f.rootId, mode: 'USER', createdById: f.owner.id, granteeEmail: f.guest.email })
    await createShare({ nodeId: f.contracts.id, mode: 'USER', createdById: f.owner.id, granteeEmail: f.guest.email })
    const { ctx } = await resolver.forNode({ nodeId: f.msa.id, user: authUser(f.guest) })
    expect(ctx.scopeRootId).toBe(f.contracts.id)
  })

  it('throws NOT_FOUND for an unknown node id', async () => {
    await expect(resolver.forNode({ nodeId: '00000000-0000-0000-0000-000000000000' })).rejects.toBeInstanceOf(DomainError)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter api test -- share-token` and `pnpm --filter api test:e2e -- access`
Expected: FAIL — `Cannot find module './share-token'` / `AccessResolver` is not registered.

- [ ] **Step 3: Implement tokens and the context type**

`apps/api/src/access/share-token.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto'

/**
 * Only the hash is persisted. Because the token is random, the hash is still a
 * single indexed lookup — but a database dump no longer hands out live links.
 */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function generateShareToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenHash: hashShareToken(token) }
}
```

`apps/api/src/access/access-context.ts`:
```ts
export type AccessRole = 'OWNER' | 'VIEWER'

/**
 * Produced once per request. Every node read applies `scopePath` / `scopeRootId`,
 * so reading outside the granted subtree is impossible by construction rather than
 * by remembering a check.
 */
export type AccessContext = {
  role: AccessRole
  roomId: string
  /** Node the caller's access is rooted at: the room root for an owner, the shared node for a viewer. */
  scopeRootId: string
  /** childPath(scopeRoot) — the LIKE prefix matching everything strictly beneath the scope root. */
  scopePath: string
  userId?: string
  shareToken?: string
  viaShareId?: string
}

export const isOwner = (ctx: AccessContext) => ctx.role === 'OWNER'
```

- [ ] **Step 4: Implement the resolver**

`apps/api/src/access/access.resolver.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { DomainError, notFound } from '../common/errors'
import { AuthUser } from '../auth/auth.service'
import { ancestorIds, childPath, isWithinSubtree } from '../nodes/node-path'
import { AccessContext } from './access-context'
import { hashShareToken } from './share-token'

export type NodeRow = {
  id: string
  roomId: string
  parentId: string | null
  type: 'FOLDER' | 'FILE'
  name: string
  path: string
  status: 'PENDING' | 'ACTIVE'
  currentVersionId: string | null
  sizeBytes: bigint | null
  deletedAt: Date | null
  updatedAt: Date
  createdAt: Date
}

type Input = { user?: AuthUser; shareToken?: string }

@Injectable()
export class AccessResolver {
  constructor(private readonly prisma: PrismaService) {}

  async forNode(input: Input & { nodeId: string }): Promise<{ ctx: AccessContext; node: NodeRow }> {
    const node = (await this.prisma.node.findUnique({ where: { id: input.nodeId } })) as NodeRow | null
    if (!node) throw notFound()
    return this.resolveForNode(node, input)
  }

  async forRoom(input: Input & { roomId: string }): Promise<{ ctx: AccessContext; node: NodeRow }> {
    const room = await this.prisma.dataRoom.findUnique({ where: { id: input.roomId } })
    if (!room) throw notFound()
    const root = (await this.prisma.node.findUnique({ where: { id: room.rootNodeId } })) as NodeRow | null
    if (!root) throw notFound()
    return this.resolveForNode(root, input)
  }

  private async resolveForNode(node: NodeRow, input: Input): Promise<{ ctx: AccessContext; node: NodeRow }> {
    const room = await this.prisma.dataRoom.findUniqueOrThrow({ where: { id: node.roomId } })

    // 2. Owner — scope is the whole room.
    if (input.user && room.ownerId === input.user.id) {
      const root = await this.prisma.node.findUniqueOrThrow({ where: { id: room.rootNodeId } })
      await this.assertNotDeleted(node)
      return {
        node,
        ctx: {
          role: 'OWNER',
          roomId: room.id,
          scopeRootId: root.id,
          scopePath: childPath(root),
          userId: input.user.id,
        },
      }
    }

    // 3. A live grant on this node or any ancestor. Deepest grant wins, so the most
    //    specific role applies once more than one role exists.
    const candidateIds = [...ancestorIds(node.path), node.id]
    const tokenHash = input.shareToken ? hashShareToken(input.shareToken) : null
    const email = input.user?.email.toLowerCase() ?? null

    const grants = await this.prisma.$queryRaw<
      { id: string; role: 'VIEWER'; nodeId: string; nodePath: string; nodeDeletedAt: Date | null }[]
    >`
      SELECT s.id, s.role, s."nodeId", n.path AS "nodePath", n."deletedAt" AS "nodeDeletedAt"
      FROM "Share" s
      JOIN "Node" n ON n.id = s."nodeId"
      WHERE s."nodeId" = ANY(${candidateIds}::text[])
        AND s."revokedAt" IS NULL
        AND ( (s.mode = 'PUBLIC_LINK' AND s."tokenHash" = ${tokenHash})
           OR (s.mode = 'USER'        AND s."granteeEmail" = ${email}) )
      ORDER BY length(n.path) DESC
      LIMIT 1`

    const grant = grants[0]
    if (!grant) throw notFound()

    const scopeRoot = await this.prisma.node.findUniqueOrThrow({ where: { id: grant.nodeId } })
    // Defensive: a grant must actually contain the requested node.
    if (!isWithinSubtree(node, scopeRoot.id, scopeRoot.path)) throw notFound()

    await this.assertNotDeleted(node)

    if (input.user && grant.nodeId && !(await this.prisma.share.findFirst({ where: { id: grant.id, granteeId: input.user.id } }))) {
      await this.prisma.share.update({ where: { id: grant.id }, data: { granteeId: input.user.id } }).catch(() => undefined)
    }

    return {
      node,
      ctx: {
        role: 'VIEWER',
        roomId: node.roomId,
        scopeRootId: scopeRoot.id,
        scopePath: childPath(scopeRoot),
        userId: input.user?.id,
        shareToken: input.shareToken,
        viaShareId: grant.id,
      },
    }
  }

  /**
   * 4. Tombstone check. The node's own path already lists every ancestor, so this is
   *    the same array — one query, no recursion.
   */
  private async assertNotDeleted(node: NodeRow) {
    if (node.deletedAt) throw new DomainError('GONE', 'This item was deleted by the owner')
    const ids = ancestorIds(node.path)
    if (ids.length === 0) return
    const rows = await this.prisma.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM "Node" WHERE id = ANY(${ids}::text[]) AND "deletedAt" IS NOT NULL LIMIT 1`
    if (rows.length > 0) throw new DomainError('GONE', 'This item was deleted by the owner')
  }
}
```

- [ ] **Step 5: Implement the guard**

`apps/api/src/access/access.guard.ts`:
```ts
import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Request } from 'express'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import { AppEnv } from '../config/env'
import { PrismaService } from '../prisma/prisma.service'
import { DomainError } from '../common/errors'
import { AccessResolver } from './access.resolver'
import { AccessContext } from './access-context'

export const REQUIRE_OWNER = 'require_owner'
/** Marks a route as a mutation: a VIEWER reaching it gets 403, not 404, because existence is already known. */
export const RequireOwner = () => SetMetadata(REQUIRE_OWNER, true)

export const Access = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): AccessContext => (ctx.switchToHttp().getRequest() as never as { access: AccessContext }).access,
)

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly resolver: AccessResolver,
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    const req = execCtx.switchToHttp().getRequest<Request & { access?: AccessContext; accessNode?: unknown }>()
    const shareToken = (req.headers['x-share-token'] as string | undefined) ?? undefined
    const user = await this.userFromRequest(req)

    if (!user && !shareToken) throw new DomainError('INVALID_CREDENTIALS', 'Sign in or open a share link')

    // Precedence matters. A viewer scoped to a subfolder holds no grant on the room
    // root, so resolving by roomId first would 404 them out of their own share.
    // Node id in the route wins, then an explicit parentId, then the room root.
    const nodeId = (req.params.id ?? req.params.nodeId ?? (req.query.parentId as string | undefined)) as string | undefined
    const roomId = req.params.roomId as string | undefined

    const resolved = nodeId
      ? await this.resolver.forNode({ nodeId, user, shareToken })
      : await this.resolver.forRoom({ roomId: roomId!, user, shareToken })

    if (this.reflector.get<boolean>(REQUIRE_OWNER, execCtx.getHandler()) && resolved.ctx.role !== 'OWNER') {
      throw new DomainError('FORBIDDEN_ROLE', 'Read-only access')
    }

    req.access = resolved.ctx
    req.accessNode = resolved.node
    return true
  }

  private async userFromRequest(req: Request) {
    const header = req.headers.authorization
    const raw = header?.startsWith('Bearer ') ? header.slice(7) : (req.cookies?.access_token as string | undefined)
    if (!raw) return undefined
    try {
      const { sub } = this.jwt.verify<{ sub: string }>(raw, { secret: this.config.get('JWT_SECRET', { infer: true }) })
      const user = await this.prisma.user.findUnique({ where: { id: sub } })
      return user ? { id: user.id, email: user.email, name: user.name } : undefined
    } catch {
      return undefined
    }
  }
}

export const AccessNode = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext) => (ctx.switchToHttp().getRequest() as never as { accessNode: unknown }).accessNode,
)
```

`apps/api/src/access/access.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { AccessResolver } from './access.resolver'
import { AccessGuard } from './access.guard'

@Module({
  imports: [JwtModule.register({})],
  providers: [AccessResolver, AccessGuard],
  exports: [AccessResolver, AccessGuard],
})
export class AccessModule {}
```

Add `AccessModule` to `AppModule.imports`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter api test -- share-token` then `pnpm --filter api test:e2e -- access`
Expected: all eleven access assertions PASS. The three that matter most: stranger gets `NOT_FOUND` (not `FORBIDDEN_ROLE`), a scoped viewer cannot reach a sibling or the root, and a deleted ancestor yields `GONE`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/access apps/api/test/access.e2e-spec.ts apps/api/src/app.module.ts
git commit -m "feat(api): single access resolver with scoped context, deepest-grant-wins and tombstone checks"
```

---

### Task 10: Folder listing with breadcrumbs, folder creation, rename

**Files:**
- Create: `apps/api/src/nodes/nodes.repository.ts`, `nodes.service.ts`, `nodes.controller.ts`, `nodes.module.ts`
- Create: `apps/api/src/nodes/dto/nodes.dto.ts`
- Test: `apps/api/test/nodes-list.e2e-spec.ts`

**Interfaces:**
- Consumes: `AccessContext`, `AccessGuard`, `Access`, `AccessNode`, `RequireOwner`, `childPath`, `ancestorIds`, `encodeCursor`, `decodeCursor`, `NodeRow`
- Produces:
  - `NodesRepository.listChildren(ctx, parent, opts): Promise<{ items: NodeRow[]; nextCursor: string | null }>` where `opts = { cursor?: string; limit: number; sort: 'name' | 'updatedAt' | 'size' }`
  - `NodesRepository.breadcrumbs(ctx, node): Promise<{ id: string; name: string; type: 'FOLDER' | 'FILE' }[]>`
  - `NodesService.createFolder(ctx, parent, name)`, `NodesService.rename(ctx, node, name)`, `NodesService.list(ctx, parent, opts)`
  - `GET /rooms/:roomId/nodes`, `POST /rooms/:roomId/folders`, `PATCH /nodes/:id`

- [ ] **Step 1: Write the failing tests**

`apps/api/test/nodes-list.e2e-spec.ts`:
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

describe('node listing', () => {
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

  async function ownerFixture() {
    const owner = await createUser()
    const { accessToken } = (
      await request(app.getHttpServer()).post('/auth/login').send({ email: owner.email, password: owner.password })
    ).body
    const { roomId, rootId, root } = await createRoom(owner.id)
    return { owner, token: accessToken as string, roomId, rootId, root: { ...root, roomId } }
  }

  it('lists direct children with folders first, then files, both by name', async () => {
    const f = await ownerFixture()
    await createFile(f.root, 'b.pdf', f.owner.id)
    await createFile(f.root, 'a.pdf', f.owner.id)
    await createFolder(f.root, 'Zebra', f.owner.id)
    await createFolder(f.root, 'Alpha', f.owner.id)

    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes`)
      .set({ Authorization: `Bearer ${f.token}` })
      .expect(200)

    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual(['Alpha', 'Zebra', 'a.pdf', 'b.pdf'])
    expect(res.body.breadcrumbs).toEqual([{ id: f.rootId, name: expect.any(String), type: 'FOLDER' }])
    expect(res.body.nextCursor).toBeNull()
  })

  it('does not list PENDING uploads', async () => {
    const f = await ownerFixture()
    await createFile(f.root, 'visible.pdf', f.owner.id)
    await prisma.node.create({
      data: { roomId: f.roomId, parentId: f.rootId, type: 'FILE', name: 'ghost.pdf', path: `/${f.rootId}/`, status: 'PENDING', createdById: f.owner.id },
    })

    const res = await request(app.getHttpServer()).get(`/rooms/${f.roomId}/nodes`).set({ Authorization: `Bearer ${f.token}` }).expect(200)
    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual(['visible.pdf'])
  })

  it('does not list soft-deleted children', async () => {
    const f = await ownerFixture()
    const gone = await createFile(f.root, 'gone.pdf', f.owner.id)
    await prisma.node.update({ where: { id: gone.id }, data: { deletedAt: new Date() } })
    const res = await request(app.getHttpServer()).get(`/rooms/${f.roomId}/nodes`).set({ Authorization: `Bearer ${f.token}` }).expect(200)
    expect(res.body.items).toEqual([])
  })

  it('paginates with a keyset cursor and never repeats or skips an item', async () => {
    const f = await ownerFixture()
    for (let i = 1; i <= 7; i++) await createFile(f.root, `f${String(i).padStart(2, '0')}.pdf`, f.owner.id)

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const url = `/rooms/${f.roomId}/nodes?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = await request(app.getHttpServer()).get(url).set({ Authorization: `Bearer ${f.token}` }).expect(200)
      seen.push(...page.body.items.map((i: { name: string }) => i.name))
      cursor = page.body.nextCursor
    } while (cursor)

    expect(seen).toEqual(['f01.pdf', 'f02.pdf', 'f03.pdf', 'f04.pdf', 'f05.pdf', 'f06.pdf', 'f07.pdf'])
    expect(new Set(seen).size).toBe(7)
  })

  it('rejects a malformed cursor with 422', async () => {
    const f = await ownerFixture()
    await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes?cursor=%%%`)
      .set({ Authorization: `Bearer ${f.token}` })
      .expect(422)
  })

  it('truncates breadcrumbs at the guest scope root', async () => {
    const f = await ownerFixture()
    const legal = await createFolder(f.root, 'Legal', f.owner.id)
    const contracts = await createFolder(legal, 'Contracts', f.owner.id)
    const token = 'crumbs-token'
    await createShare({ nodeId: legal.id, mode: 'PUBLIC_LINK', createdById: f.owner.id, tokenHash: hashShareToken(token) })

    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes?parentId=${contracts.id}`)
      .set({ 'X-Share-Token': token })
      .expect(200)

    expect(res.body.breadcrumbs.map((b: { name: string }) => b.name)).toEqual(['Legal', 'Contracts'])
  })

  it('creates a folder and rejects a duplicate name with 409', async () => {
    const f = await ownerFixture()
    await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/folders`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ parentId: f.rootId, name: 'Financials' })
      .expect(201)

    await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/folders`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ parentId: f.rootId, name: 'financials' })
      .expect(409)
  })

  it('rejects a folder name containing a slash with 400', async () => {
    const f = await ownerFixture()
    await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/folders`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ parentId: f.rootId, name: 'a/b' })
      .expect(400)
  })

  it('renames a node', async () => {
    const f = await ownerFixture()
    const file = await createFile(f.root, 'old.pdf', f.owner.id)
    await request(app.getHttpServer())
      .patch(`/nodes/${file.id}`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ name: 'new.pdf' })
      .expect(200)
    await expect(prisma.node.findUniqueOrThrow({ where: { id: file.id } })).resolves.toMatchObject({ name: 'new.pdf' })
  })

  it('refuses a rename from a share viewer with 403, not 404', async () => {
    const f = await ownerFixture()
    const file = await createFile(f.root, 'readonly.pdf', f.owner.id)
    const token = 'viewer-token'
    await createShare({ nodeId: f.rootId, mode: 'PUBLIC_LINK', createdById: f.owner.id, tokenHash: hashShareToken(token) })

    await request(app.getHttpServer()).patch(`/nodes/${file.id}`).set({ 'X-Share-Token': token }).send({ name: 'hacked.pdf' }).expect(403)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter api test:e2e -- nodes-list`
Expected: FAIL — 404 on `GET /rooms/:roomId/nodes`.

- [ ] **Step 3: Implement the repository**

`apps/api/src/nodes/nodes.repository.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { AccessContext } from '../access/access-context'
import { NodeRow } from '../access/access.resolver'
import { ancestorIds, childPath } from './node-path'
import { decodeCursor, encodeCursor } from './cursor'

export type SortMode = 'name' | 'updatedAt' | 'size'
export type Crumb = { id: string; name: string; type: 'FOLDER' | 'FILE' }

/**
 * Every read here carries the caller's scope prefix. A query without it would be a
 * cross-room leak, so the scope is applied in the WHERE clause rather than filtered
 * after the fetch.
 */
@Injectable()
export class NodesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listChildren(
    ctx: AccessContext,
    parent: { id: string; path: string },
    opts: { cursor?: string; limit: number; sort: SortMode },
  ): Promise<{ items: NodeRow[]; nextCursor: string | null }> {
    // Folders before files is baked into the sort key so one keyset comparison
    // covers both the grouping and the ordering.
    const sortExpr =
      opts.sort === 'name'
        ? Prisma.sql`lower(name)`
        : opts.sort === 'updatedAt'
          ? Prisma.sql`to_char("updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')`
          : Prisma.sql`lpad(coalesce("sizeBytes", 0)::text, 20, '0')`
    const descending = opts.sort !== 'name'
    const comparator = Prisma.raw(descending ? '<' : '>')
    const direction = Prisma.raw(descending ? 'DESC' : 'ASC')

    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
    const childPrefix = childPath(parent)

    const rows = await this.prisma.$queryRaw<(NodeRow & { sort_key: string })[]>`
      WITH scoped AS (
        SELECT *,
               (CASE WHEN type = 'FOLDER' THEN '0' ELSE '1' END || ${sortExpr}) AS sort_key
        FROM "Node"
        WHERE "roomId" = ${ctx.roomId}
          AND "parentId" = ${parent.id}
          AND path = ${childPrefix}
          AND path LIKE ${ctx.scopePath} || '%'
          AND "deletedAt" IS NULL
          AND status = 'ACTIVE'
      )
      SELECT * FROM scoped
      WHERE ${cursor ? Prisma.sql`(sort_key, id) ${comparator} (${cursor.key}, ${cursor.id})` : Prisma.sql`TRUE`}
      ORDER BY sort_key ${direction}, id ${direction}
      LIMIT ${opts.limit + 1}`

    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    const last = page[page.length - 1]
    return {
      items: page.map(({ sort_key, ...node }) => node as NodeRow),
      nextCursor: hasMore && last ? encodeCursor({ key: last.sort_key, id: last.id }) : null,
    }
  }

  /**
   * The node's path already lists its ancestors, so this is one query with no
   * recursion. Ancestors above the caller's scope root are dropped, which is what
   * stops a guest from seeing — or clicking into — the rest of the Data Room.
   */
  async breadcrumbs(ctx: AccessContext, node: { id: string; name: string; type: 'FOLDER' | 'FILE'; path: string }): Promise<Crumb[]> {
    const ids = ancestorIds(node.path)
    const scopeIdx = ids.indexOf(ctx.scopeRootId)
    const visible = scopeIdx >= 0 ? ids.slice(scopeIdx) : []

    const rows = visible.length
      ? await this.prisma.$queryRaw<Crumb[]>`
          SELECT id, name, type FROM "Node" WHERE id = ANY(${visible}::text[])`
      : []

    const byId = new Map(rows.map((r) => [r.id, r]))
    const ordered = visible.map((id) => byId.get(id)).filter((c): c is Crumb => Boolean(c))
    return [...ordered, { id: node.id, name: node.name, type: node.type }]
  }

  /** Names already used by live siblings, lower-cased to match the database index. */
  async takenSiblingNames(parentId: string): Promise<Set<string>> {
    const rows = await this.prisma.node.findMany({ where: { parentId, deletedAt: null }, select: { name: true } })
    return new Set(rows.map((r) => r.name.toLowerCase()))
  }
}
```

The listing filters on both `"parentId" = parent.id` and `path = childPrefix`. The parent id alone would be enough; the path equality is what lets the `(roomId, path)` prefix index serve the query and doubles as a consistency assertion — a row whose `parentId` and `path` disagree is a bug and will simply not appear.

- [ ] **Step 4: Implement DTOs, service, controller**

`apps/api/src/nodes/dto/nodes.dto.ts`:
```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator'
import { Type } from 'class-transformer'

/** Slashes would corrupt path arithmetic; control characters break the cursor. */
const SAFE_NAME = /^[^/\\ -]+$/

export class NodeNameDto {
  @ApiProperty({ example: 'Financials' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(SAFE_NAME, { message: 'name must not contain slashes or control characters' })
  name: string
}

export class CreateFolderDto extends NodeNameDto {
  @ApiProperty({ description: 'Parent folder id; the room root id for a top-level folder' })
  @IsString()
  parentId: string
}

export class RenameNodeDto extends NodeNameDto {}

export class ListNodesQueryDto {
  @ApiPropertyOptional({ description: 'Folder to list; defaults to the room root' })
  @IsOptional()
  @IsString()
  parentId?: string

  @ApiPropertyOptional({ description: 'Keyset cursor from a previous page' })
  @IsOptional()
  @IsString()
  cursor?: string

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number

  @ApiPropertyOptional({ enum: ['name', 'updatedAt', 'size'], default: 'name' })
  @IsOptional()
  @IsIn(['name', 'updatedAt', 'size'])
  sort?: 'name' | 'updatedAt' | 'size'
}
```

`apps/api/src/nodes/nodes.service.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AccessContext } from '../access/access-context'
import { NodeRow } from '../access/access.resolver'
import { DomainError } from '../common/errors'
import { childPath } from './node-path'
import { NodesRepository, SortMode } from './nodes.repository'

@Injectable()
export class NodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: NodesRepository,
  ) {}

  async list(ctx: AccessContext, parent: NodeRow, opts: { cursor?: string; limit?: number; sort?: SortMode }) {
    if (parent.type !== 'FOLDER') throw new DomainError('INVALID_TARGET', 'Only folders can be listed')
    const { items, nextCursor } = await this.repo.listChildren(ctx, parent, {
      cursor: opts.cursor,
      limit: opts.limit ?? 50,
      sort: opts.sort ?? 'name',
    })
    return {
      items,
      nextCursor,
      breadcrumbs: await this.repo.breadcrumbs(ctx, parent),
      parent: {
        id: parent.id,
        name: parent.name,
        // Suppressed at the scope root so a guest has nothing to navigate up into.
        parentId: parent.id === ctx.scopeRootId ? null : parent.parentId,
      },
      role: ctx.role,
      scopeRootId: ctx.scopeRootId,
    }
  }

  async createFolder(ctx: AccessContext, parent: NodeRow, name: string) {
    if (parent.type !== 'FOLDER') throw new DomainError('INVALID_TARGET', 'Cannot create a folder inside a file')
    return this.prisma.node.create({
      data: {
        roomId: parent.roomId,
        parentId: parent.id,
        type: 'FOLDER',
        name,
        path: childPath(parent),
        status: 'ACTIVE',
        createdById: ctx.userId!,
      },
    })
  }

  /** Conflicts are reported by the partial unique index and mapped to 409 by the Prisma filter. */
  async rename(_ctx: AccessContext, node: NodeRow, name: string) {
    return this.prisma.node.update({ where: { id: node.id }, data: { name } })
  }
}
```

`apps/api/src/nodes/nodes.controller.ts`:
```ts
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger'
import { Access, AccessGuard, AccessNode, RequireOwner } from '../access/access.guard'
import { AccessContext } from '../access/access-context'
import { NodeRow } from '../access/access.resolver'
import { NodesService } from './nodes.service'
import { CreateFolderDto, ListNodesQueryDto, RenameNodeDto } from './dto/nodes.dto'
import { PrismaService } from '../prisma/prisma.service'
import { notFound } from '../common/errors'

@ApiTags('nodes')
@ApiBearerAuth('access-token')
@ApiSecurity('share-token')
@Controller()
export class NodesController {
  constructor(
    private readonly nodes: NodesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('rooms/:roomId/nodes')
  @UseGuards(AccessGuard)
  @ApiOperation({ summary: 'List a folder: children, breadcrumbs and the caller role' })
  @ApiResponse({ status: 404, description: 'Not found or no access' })
  @ApiResponse({ status: 410, description: 'The folder or an ancestor was deleted by the owner' })
  @ApiResponse({ status: 422, description: 'Malformed cursor' })
  list(@Access() ctx: AccessContext, @AccessNode() node: NodeRow, @Query() query: ListNodesQueryDto) {
    return this.nodes.list(ctx, node, query)
  }

  @Post('rooms/:roomId/folders')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({ summary: 'Create a folder' })
  @ApiResponse({ status: 403, description: 'Read-only access' })
  @ApiResponse({ status: 409, description: 'A folder or file with this name already exists here' })
  async createFolder(@Access() ctx: AccessContext, @Body() dto: CreateFolderDto) {
    const parent = (await this.prisma.node.findFirst({
      where: { id: dto.parentId, roomId: ctx.roomId, deletedAt: null },
    })) as NodeRow | null
    if (!parent) throw notFound()
    return this.nodes.createFolder(ctx, parent, dto.name)
  }

  @Patch('nodes/:id')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({ summary: 'Rename a folder or file' })
  @ApiResponse({ status: 403, description: 'Read-only access' })
  @ApiResponse({ status: 409, description: 'That name is taken in this folder' })
  rename(@Access() ctx: AccessContext, @AccessNode() node: NodeRow, @Body() dto: RenameNodeDto) {
    return this.nodes.rename(ctx, node, dto.name)
  }
}
```

`POST /rooms/:roomId/folders` resolves access from the room and then loads `parentId` constrained to `ctx.roomId`, so a parent id from a different room is `404` rather than a cross-room write.

`apps/api/src/nodes/nodes.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { NodesController } from './nodes.controller'
import { NodesRepository } from './nodes.repository'
import { NodesService } from './nodes.service'
import { RollupService } from './rollup.service'

@Module({
  imports: [AccessModule],
  controllers: [NodesController],
  providers: [NodesRepository, NodesService, RollupService],
  exports: [NodesRepository, NodesService, RollupService],
})
export class NodesModule {}
```

Add `NodesModule` to `AppModule.imports`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter api test:e2e -- nodes-list`
Expected: all PASS. Two assertions carry the most weight: pagination visits all seven files exactly once, and the guest's breadcrumbs start at `Legal` rather than at the room root.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/nodes apps/api/test/nodes-list.e2e-spec.ts apps/api/src/app.module.ts
git commit -m "feat(api): scoped folder listing with keyset pagination, breadcrumbs, folder create and rename"
```

---

### Task 11: Move, in one locked transaction

**Files:**
- Create: `apps/api/src/nodes/move.service.ts`
- Modify: `apps/api/src/nodes/nodes.controller.ts` (add `POST /nodes/:id/move`), `apps/api/src/nodes/nodes.module.ts`
- Test: `apps/api/test/move.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `childPath`, `DomainError`, `AccessContext`, `NodeRow`
- Produces: `MoveService.move(ctx: AccessContext, sourceId: string, targetParentId: string): Promise<NodeRow>` and `POST /nodes/:id/move`

- [ ] **Step 1: Write the failing tests**

`apps/api/test/move.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing'
import { AppModule } from '../src/app.module'
import { MoveService } from '../src/nodes/move.service'
import { AccessContext } from '../src/access/access-context'
import { childPath, ROOT_PATH } from '../src/nodes/node-path'
import { createFile, createFolder, createRoom, createUser, prisma } from './factories'

describe('MoveService', () => {
  let move: MoveService

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    move = mod.get(MoveService)
  })
  afterAll(() => prisma.$disconnect())

  async function tree() {
    const owner = await createUser()
    const { roomId, rootId, root: rootRow } = await createRoom(owner.id)
    const root = { ...rootRow, roomId }
    const legal = await createFolder(root, 'Legal', owner.id)
    const contracts = await createFolder(legal, 'Contracts', owner.id)
    const msa = await createFile(contracts, 'MSA.pdf', owner.id)
    const financials = await createFolder(root, 'Financials', owner.id)
    const ctx: AccessContext = {
      role: 'OWNER',
      roomId,
      scopeRootId: rootId,
      scopePath: childPath({ id: rootId, path: ROOT_PATH }),
      userId: owner.id,
    }
    return { owner, roomId, rootId, root, legal, contracts, msa, financials, ctx }
  }

  it('moves a file and rewrites its path', async () => {
    const t = await tree()
    await move.move(t.ctx, t.msa.id, t.financials.id)
    const moved = await prisma.node.findUniqueOrThrow({ where: { id: t.msa.id } })
    expect(moved.parentId).toBe(t.financials.id)
    expect(moved.path).toBe(childPath(t.financials))
  })

  it('rewrites the path of every descendant when a folder moves', async () => {
    const t = await tree()
    await move.move(t.ctx, t.legal.id, t.financials.id)

    const legal = await prisma.node.findUniqueOrThrow({ where: { id: t.legal.id } })
    const contracts = await prisma.node.findUniqueOrThrow({ where: { id: t.contracts.id } })
    const msa = await prisma.node.findUniqueOrThrow({ where: { id: t.msa.id } })

    expect(legal.path).toBe(childPath(t.financials))
    expect(contracts.path).toBe(`${childPath(t.financials)}${t.legal.id}/`)
    expect(msa.path).toBe(`${childPath(t.financials)}${t.legal.id}/${t.contracts.id}/`)
  })

  it('refuses to move a folder into its own descendant', async () => {
    const t = await tree()
    await expect(move.move(t.ctx, t.legal.id, t.contracts.id)).rejects.toMatchObject({ code: 'MOVE_CYCLE' })
  })

  it('refuses to move a node into itself', async () => {
    const t = await tree()
    await expect(move.move(t.ctx, t.legal.id, t.legal.id)).rejects.toMatchObject({ code: 'MOVE_CYCLE' })
  })

  it('refuses to move into a file', async () => {
    const t = await tree()
    await expect(move.move(t.ctx, t.financials.id, t.msa.id)).rejects.toMatchObject({ code: 'INVALID_TARGET' })
  })

  it('refuses to move the scope root', async () => {
    const t = await tree()
    await expect(move.move(t.ctx, t.rootId, t.financials.id)).rejects.toMatchObject({ code: 'INVALID_TARGET' })
  })

  it('refuses a target in another room', async () => {
    const t = await tree()
    const other = await createUser()
    const otherRoom = await createRoom(other.id)
    await expect(move.move(t.ctx, t.msa.id, otherRoom.rootId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reports a name collision in the destination as NAME_CONFLICT', async () => {
    const t = await tree()
    await createFile(t.financials, 'MSA.pdf', t.owner.id)
    await expect(move.move(t.ctx, t.msa.id, t.financials.id)).rejects.toMatchObject({ code: 'NAME_CONFLICT' })
  })

  it('is a no-op that still succeeds when the target is the current parent', async () => {
    const t = await tree()
    const before = await prisma.node.findUniqueOrThrow({ where: { id: t.msa.id } })
    await move.move(t.ctx, t.msa.id, t.contracts.id)
    const after = await prisma.node.findUniqueOrThrow({ where: { id: t.msa.id } })
    expect(after.path).toBe(before.path)
    expect(after.parentId).toBe(before.parentId)
  })

  it('leaves the tree untouched when the move fails', async () => {
    const t = await tree()
    await createFile(t.financials, 'MSA.pdf', t.owner.id)
    await expect(move.move(t.ctx, t.msa.id, t.financials.id)).rejects.toBeDefined()
    const msa = await prisma.node.findUniqueOrThrow({ where: { id: t.msa.id } })
    expect(msa.path).toBe(childPath(t.contracts))
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter api test:e2e -- move`
Expected: FAIL — `Nest could not find MoveService`.

- [ ] **Step 3: Implement the service**

`apps/api/src/nodes/move.service.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { AccessContext } from '../access/access-context'
import { DomainError, notFound } from '../common/errors'
import { childPath } from './node-path'

type LockedNode = { id: string; roomId: string; parentId: string | null; path: string; name: string; type: 'FOLDER' | 'FILE' }

@Injectable()
export class MoveService {
  constructor(private readonly prisma: PrismaService) {}

  async move(ctx: AccessContext, sourceId: string, targetParentId: string) {
    if (sourceId === ctx.scopeRootId) throw new DomainError('INVALID_TARGET', 'The root folder cannot be moved')

    return this.prisma.$transaction(async (tx) => {
      // Lock both endpoints so a concurrent move cannot slip between the cycle
      // check and the UPDATE.
      const locked = await tx.$queryRaw<LockedNode[]>`
        SELECT id, "roomId", "parentId", path, name, type
        FROM "Node"
        WHERE id IN (${sourceId}, ${targetParentId})
          AND "roomId" = ${ctx.roomId}
          AND "deletedAt" IS NULL
        FOR UPDATE`

      const src = locked.find((n) => n.id === sourceId)
      const dst = locked.find((n) => n.id === targetParentId)
      if (!src || !dst) throw notFound()

      if (dst.id === src.id) throw new DomainError('MOVE_CYCLE', 'A folder cannot be moved into itself')
      // The destination's own path lists its ancestors, so containment is a prefix test.
      if (dst.path.startsWith(childPath(src))) throw new DomainError('MOVE_CYCLE', 'A folder cannot be moved into its own subfolder')
      if (dst.type !== 'FOLDER') throw new DomainError('INVALID_TARGET', 'Files cannot contain other items')
      if (src.parentId === dst.id) return tx.node.findUniqueOrThrow({ where: { id: src.id } })

      const oldPrefix = childPath(src)
      const newPrefix = `${childPath(dst)}${src.id}/`

      try {
        // Descendants. The source's own path holds ancestors only, so this pattern
        // never matches the source row itself — that update is separate, below.
        await tx.$executeRaw`
          UPDATE "Node"
          SET path = ${newPrefix} || substring(path from ${oldPrefix.length + 1})
          WHERE "roomId" = ${src.roomId} AND path LIKE ${`${oldPrefix}%`}`

        return await tx.node.update({
          where: { id: src.id },
          data: { parentId: dst.id, path: childPath(dst) },
        })
      } catch (error) {
        // The partial unique index is the authority on collisions; a pre-check would race.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new DomainError('NAME_CONFLICT', `"${src.name}" already exists in the destination folder`)
        }
        throw error
      }
    })
  }
}
```

- [ ] **Step 4: Expose the endpoint**

Add to `apps/api/src/nodes/nodes.controller.ts`:
```ts
  @Post('nodes/:id/move')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({ summary: 'Move a folder or file into another folder' })
  @ApiResponse({ status: 403, description: 'Read-only access' })
  @ApiResponse({ status: 409, description: 'Name collision in the destination, or a move into own descendant' })
  moveNode(@Access() ctx: AccessContext, @Param('id') id: string, @Body() dto: MoveNodeDto) {
    return this.move.move(ctx, id, dto.targetParentId)
  }
```

Inject `private readonly move: MoveService` into the controller constructor, add `MoveService` to `NodesModule.providers`, and add to `apps/api/src/nodes/dto/nodes.dto.ts`:
```ts
export class MoveNodeDto {
  @ApiProperty({ description: 'Destination folder id' })
  @IsString()
  targetParentId: string
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter api test:e2e -- move`
Expected: all ten PASS. The two that justify the whole design: descendant paths are rewritten by a single UPDATE, and a failed move leaves the tree byte-identical.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/nodes apps/api/test/move.e2e-spec.ts
git commit -m "feat(api): move with row locks, cycle detection and single-statement subtree path rewrite"
```

---

### Task 12: Delete with a preview of what will be destroyed

**Files:**
- Create: `apps/api/src/nodes/delete.service.ts`
- Modify: `apps/api/src/nodes/nodes.controller.ts`, `nodes.module.ts`
- Test: `apps/api/test/delete.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `RollupService`, `subtreeLikePattern`, `AccessContext`, `NodeRow`
- Produces:
  - `DeleteService.preview(ctx, node): Promise<{ folders: number; files: number; bytes: number; activeShares: number }>`
  - `DeleteService.remove(ctx, node): Promise<{ id: string; deletedNodes: number }>`
  - `GET /nodes/:id/deletion-preview`, `DELETE /nodes/:id`, `GET /nodes/:id/rollup`

- [ ] **Step 1: Write the failing tests**

`apps/api/test/delete.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing'
import { AppModule } from '../src/app.module'
import { DeleteService } from '../src/nodes/delete.service'
import { AccessResolver } from '../src/access/access.resolver'
import { AccessContext } from '../src/access/access-context'
import { childPath, ROOT_PATH } from '../src/nodes/node-path'
import { hashShareToken } from '../src/access/share-token'
import { createFile, createFolder, createRoom, createShare, createUser, prisma } from './factories'

describe('DeleteService', () => {
  let del: DeleteService
  let resolver: AccessResolver

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    del = mod.get(DeleteService)
    resolver = mod.get(AccessResolver)
  })
  afterAll(() => prisma.$disconnect())

  async function tree() {
    const owner = await createUser()
    const { roomId, rootId, root: rootRow } = await createRoom(owner.id)
    const root = { ...rootRow, roomId }
    const legal = await createFolder(root, 'Legal', owner.id)
    const contracts = await createFolder(legal, 'Contracts', owner.id)
    const msa = await createFile(contracts, 'MSA.pdf', owner.id, 3000)
    const nda = await createFile(legal, 'NDA.pdf', owner.id, 2000)
    const ctx: AccessContext = {
      role: 'OWNER',
      roomId,
      scopeRootId: rootId,
      scopePath: childPath({ id: rootId, path: ROOT_PATH }),
      userId: owner.id,
    }
    return { owner, roomId, rootId, root, legal, contracts, msa, nda, ctx }
  }

  it('previews the whole subtree, not just direct children', async () => {
    const t = await tree()
    const legal = await prisma.node.findUniqueOrThrow({ where: { id: t.legal.id } })
    await expect(del.preview(t.ctx, legal)).resolves.toMatchObject({ folders: 1, files: 2, bytes: 5000 })
  })

  it('counts the shares that will stop working', async () => {
    const t = await tree()
    await createShare({ nodeId: t.contracts.id, mode: 'PUBLIC_LINK', createdById: t.owner.id, tokenHash: hashShareToken('t1') })
    await createShare({ nodeId: t.msa.id, mode: 'USER', createdById: t.owner.id, granteeEmail: 'counsel@example.com' })
    const revoked = await createShare({ nodeId: t.nda.id, mode: 'PUBLIC_LINK', createdById: t.owner.id, tokenHash: hashShareToken('t2') })
    await prisma.share.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } })

    const legal = await prisma.node.findUniqueOrThrow({ where: { id: t.legal.id } })
    await expect(del.preview(t.ctx, legal)).resolves.toMatchObject({ activeShares: 2 })
  })

  it('tombstones the node and every descendant, not only the subtree root', async () => {
    const t = await tree()
    const legal = await prisma.node.findUniqueOrThrow({ where: { id: t.legal.id } })
    const result = await del.remove(t.ctx, legal)
    expect(result.deletedNodes).toBe(4)

    for (const id of [t.legal.id, t.contracts.id, t.msa.id, t.nda.id]) {
      const row = await prisma.node.findUniqueOrThrow({ where: { id } })
      expect(row.deletedAt).not.toBeNull()
    }
  })

  it('keeps descendants out of name search once the parent is deleted', async () => {
    const t = await tree()
    const legal = await prisma.node.findUniqueOrThrow({ where: { id: t.legal.id } })
    await del.remove(t.ctx, legal)
    const rows = await prisma.node.findMany({ where: { roomId: t.roomId, name: { contains: 'MSA' }, deletedAt: null } })
    expect(rows).toEqual([])
  })

  it('makes a guest inside the deleted folder receive GONE', async () => {
    const t = await tree()
    const token = 'gone-token'
    await createShare({ nodeId: t.contracts.id, mode: 'PUBLIC_LINK', createdById: t.owner.id, tokenHash: hashShareToken(token) })
    const legal = await prisma.node.findUniqueOrThrow({ where: { id: t.legal.id } })
    await del.remove(t.ctx, legal)

    await expect(resolver.forNode({ nodeId: t.msa.id, shareToken: token })).rejects.toMatchObject({ code: 'GONE' })
  })

  it('frees the name for reuse after deletion', async () => {
    const t = await tree()
    const nda = await prisma.node.findUniqueOrThrow({ where: { id: t.nda.id } })
    await del.remove(t.ctx, nda)
    const legal = await prisma.node.findUniqueOrThrow({ where: { id: t.legal.id } })
    await expect(createFile({ ...legal, roomId: t.roomId }, 'NDA.pdf', t.owner.id)).resolves.toBeDefined()
  })

  it('refuses to delete the room root through the node endpoint', async () => {
    const t = await tree()
    const root = await prisma.node.findUniqueOrThrow({ where: { id: t.rootId } })
    await expect(del.remove(t.ctx, root)).rejects.toMatchObject({ code: 'INVALID_TARGET' })
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter api test:e2e -- delete`
Expected: FAIL — `Nest could not find DeleteService`.

- [ ] **Step 3: Implement the service**

`apps/api/src/nodes/delete.service.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AccessContext } from '../access/access-context'
import { NodeRow } from '../access/access.resolver'
import { DomainError } from '../common/errors'
import { subtreeLikePattern } from './node-path'
import { RollupService } from './rollup.service'

@Injectable()
export class DeleteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rollup: RollupService,
  ) {}

  /** Powers the confirmation dialog: what disappears, and who loses access. */
  async preview(ctx: AccessContext, node: NodeRow) {
    const totals = await this.rollup.forSubtree(ctx.roomId, node)
    const [row] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count
      FROM "Share" s
      JOIN "Node" n ON n.id = s."nodeId"
      WHERE s."revokedAt" IS NULL
        AND n."roomId" = ${ctx.roomId}
        AND (n.id = ${node.id} OR n.path LIKE ${subtreeLikePattern(node)})`
    return {
      folders: node.type === 'FOLDER' ? totals.folders : 0,
      files: node.type === 'FILE' ? 1 : totals.files,
      bytes: node.type === 'FILE' ? Number(node.sizeBytes ?? 0) : totals.bytes,
      activeShares: Number(row.count),
    }
  }

  /**
   * The tombstone is applied to every descendant, not only the subtree root. Marking
   * just the root would leave children visible to name search, which queries by
   * `deletedAt IS NULL` on the row itself.
   *
   * Blobs stay in the bucket; the hourly sweep is what removes them.
   */
  async remove(ctx: AccessContext, node: NodeRow) {
    if (node.id === ctx.scopeRootId) {
      throw new DomainError('INVALID_TARGET', 'Delete the Data Room itself to remove its root folder')
    }
    const deletedAt = new Date()
    return this.prisma.$transaction(async (tx) => {
      const descendants = await tx.$executeRaw`
        UPDATE "Node" SET "deletedAt" = ${deletedAt}
        WHERE "roomId" = ${ctx.roomId} AND path LIKE ${subtreeLikePattern(node)} AND "deletedAt" IS NULL`
      const self = await tx.$executeRaw`
        UPDATE "Node" SET "deletedAt" = ${deletedAt} WHERE id = ${node.id} AND "deletedAt" IS NULL`
      return { id: node.id, deletedNodes: descendants + self }
    })
  }
}
```

- [ ] **Step 4: Expose the endpoints**

Add to `apps/api/src/nodes/nodes.controller.ts`:
```ts
  @Get('nodes/:id/rollup')
  @UseGuards(AccessGuard)
  @ApiOperation({ summary: 'Total folders, files and bytes beneath a folder' })
  rollupFor(@Access() ctx: AccessContext, @AccessNode() node: NodeRow) {
    return this.rollup.forSubtree(ctx.roomId, node)
  }

  @Get('nodes/:id/deletion-preview')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({ summary: 'What deleting this item would destroy, including shares' })
  deletionPreview(@Access() ctx: AccessContext, @AccessNode() node: NodeRow) {
    return this.deletes.preview(ctx, node)
  }

  @Delete('nodes/:id')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({ summary: 'Delete a folder or file and everything beneath it' })
  @ApiResponse({ status: 403, description: 'Read-only access' })
  remove(@Access() ctx: AccessContext, @AccessNode() node: NodeRow) {
    return this.deletes.remove(ctx, node)
  }
```

Inject `private readonly deletes: DeleteService` and `private readonly rollup: RollupService`, import `Delete` from `@nestjs/common`, and register `DeleteService` in `NodesModule.providers`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter api test:e2e -- delete`
Expected: all seven PASS. The one that proves the design choice: after deleting `Legal`, a guest scoped *inside* it gets `GONE`, not a silent `404`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/nodes apps/api/test/delete.e2e-spec.ts
git commit -m "feat(api): subtree delete with tombstones and a deletion preview including affected shares"
```
