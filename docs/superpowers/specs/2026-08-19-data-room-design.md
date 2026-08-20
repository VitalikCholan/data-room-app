# Data Room — Design Spec

**Date:** 2026-08-19
**Status:** Approved, ready for implementation planning

A virtual Data Room: an owner-scoped repository of folders and PDF files, with read-only
sharing by public link or by per-user grant.

---

## 1. Scope

### In scope

**Folders** — create, nest, list contents, breadcrumb navigation, rename, delete with a
warning that states exactly what will be removed.

**Files** — multi-file upload with drag-and-drop and per-file progress, in-browser
viewing, rename, move between folders, delete. PDF only.

**Sharing** — share a Data Room, a folder, or a single file. Two modes: public link
(anyone holding the link) and permissioned (named recipients). Recipients get read-only
access to the shared item and everything beneath it. The owner can revoke.

**Auth** — email/password and Google OAuth. A Data Room is invisible to everyone except
its owner and the people it was shared with.

**Extra credit, in scope by decision** — name search across a Data Room; file versioning
on name conflict.

### Explicitly out of scope

No trash/restore UI (soft delete is an internal mechanism — see §4.6). No editor role
(the model is ready for it — see §9.3). No folder upload from the OS file picker. No
audit log. No per-share expiry dates. Nothing half-built appears in the UI.

### Multiplicity

A user owns many Data Rooms. Each is a root container listed on a dashboard. This makes
"share a whole Data Room" a real, distinct object rather than a synonym for "share the
root folder".

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vite + React + TypeScript + Tailwind + shadcn/ui | Matches the reviewing team's stack |
| Server state | TanStack Query | Cache invalidation and optimistic updates as a primitive |
| Client state | zustand, upload queue only | The only genuinely client-owned state |
| Backend | NestJS + Prisma | Matches the reviewing team's stack |
| Database | PostgreSQL | Partial unique indexes, `pg_trgm`, opclass indexes all load-bearing here |
| Blob storage | Railway bucket (S3-compatible) via presigned URLs | Same vendor as API and DB; S3 API means the code is portable |
| Local storage | MinIO in docker-compose | Presigned PUT/HEAD/DELETE behave identically to production |
| Hosting | Vercel (web) + Railway (api, Postgres, bucket) | Railway CLI and MCP already available |
| API docs | `@nestjs/swagger` at `/docs` | Also the source for generated frontend types |

Google OAuth is additive: the strategy registers only when `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` are both present, so the app boots and email/password login works
without them.

### Repository layout

```
data-room-app/
  apps/api/                    NestJS + Prisma
  apps/web/                    Vite + React
  .github/workflows/ci.yml     lint + test + build, both apps
  docker-compose.yml           Postgres + MinIO
  pnpm-workspace.yaml
  README.md
```

A pnpm workspace, not Turborepo or Nx: at two apps, a task graph and remote cache earn
nothing and add config a reviewer has to read. `pnpm --filter` covers every script.

No shared types package: `openapi-typescript` generates frontend types from
`openapi.json` into `apps/web/src/api/schema.d.ts`, committed. A shared package would
impose a build order between the two apps — `composite: true`, tsconfig paths, and an
afternoon spent on why Vercel cannot resolve the types. One direction of dependency
instead. The API contract is therefore the single source of truth, and a DTO change breaks
the frontend build rather than production.

Deliberate boundary: **web never imports Prisma types.** Otherwise the database shape leaks
into the UI and renaming a column breaks a component. Frontend types come from the public
contract.

Deploying two services from one repo needs no build hacks — both platforms support a
monorepo root directory natively:

| | Root directory | Build | Watch paths |
|---|---|---|---|
| Vercel | `apps/web` | `pnpm --filter web build`, install at repo root | `apps/web/**` |
| Railway | repo root | Nixpacks; `pnpm --filter api exec prisma generate && pnpm --filter api build`; pre-deploy `prisma migrate deploy` | `apps/api/**` |

`vercel.json` exists only for the `/api/*` rewrite (§7.1). CI is one workflow with an `api`
job (Postgres + MinIO service containers) and a `web` job.

Railway builds from the repo **root**, not `apps/api`: this is a shared pnpm workspace with a
single lockfile at the top, and a root directory of `apps/api` hides that lockfile from the
installer. Verified in deployment.

---

## 3. Data model

### 3.1 Schema

```prisma
enum NodeType   { FOLDER FILE }
enum NodeStatus { PENDING ACTIVE }
enum ShareMode  { PUBLIC_LINK USER }
enum Role       { VIEWER }

model User {
  id           String   @id @default(uuid())
  email        String   @unique          // stored lower-cased
  passwordHash String?                   // null for Google-only accounts
  googleId     String?  @unique
  name         String
  createdAt    DateTime @default(now())
}

model DataRoom {
  id         String   @id @default(uuid())
  ownerId    String
  name       String
  rootNodeId String   @unique
  createdAt  DateTime @default(now())

  @@index([ownerId, createdAt])
}

model Node {
  id               String     @id @default(uuid())
  roomId           String
  parentId         String?                        // null only on a room's root node
  type             NodeType
  name             String
  path             String                         // "/rootId/folderId/" — leading and trailing slash
  status           NodeStatus @default(PENDING)    // PENDING until upload is confirmed
  currentVersionId String?    @unique
  sizeBytes        BigInt?                         // denormalized from current version, for rollups
  deletedAt        DateTime?
  createdById      String
  createdAt        DateTime   @default(now())
  updatedAt        DateTime   @updatedAt

  @@index([parentId, name, id])   // single-folder listing + keyset pagination
  @@index([roomId, path])         // subtree prefix scan — opclass added in raw SQL
  @@index([roomId, name])         // name search — GIN pg_trgm added in raw SQL
}

model FileVersion {
  id          String   @id @default(uuid())
  nodeId      String
  versionNo   Int
  blobKey     String
  sizeBytes   BigInt
  mimeType    String
  checksum    String?
  createdById String
  createdAt   DateTime @default(now())

  @@unique([nodeId, versionNo])
}

model Share {
  id           String    @id @default(uuid())
  nodeId       String                          // a Data Room is shared via its root node
  mode         ShareMode
  role         Role      @default(VIEWER)
  tokenHash    String?   @unique               // sha256(token); the token itself is never stored
  granteeEmail String?                         // lower-cased
  granteeId    String?                         // set explicitly (seed, future audit); never written by the read path
  createdById  String
  createdAt    DateTime  @default(now())
  revokedAt    DateTime?

  @@unique([nodeId, granteeEmail])
  @@index([nodeId, revokedAt])
}
```

### 3.2 Raw SQL in migrations

Three statements Prisma cannot express declaratively. They live in migrations, not in
application code.

```sql
-- Name uniqueness within a folder, ignoring deleted rows, case-insensitive
CREATE UNIQUE INDEX node_name_uniq
  ON "Node" (parent_id, lower(name)) WHERE deleted_at IS NULL;

-- Prefix LIKE uses a btree index only with an explicit pattern opclass
CREATE INDEX node_path_prefix ON "Node" (room_id, path varchar_pattern_ops);

-- Substring name search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX node_name_trgm ON "Node" USING gin (name gin_trgm_ops);
```

`@@unique([parentId, name, deletedAt])` was considered and rejected: in PostgreSQL, NULLs
in a unique index are not equal to each other, so two live rows both holding
`deleted_at = NULL` are not treated as duplicates. That constraint would enforce nothing
on exactly the rows it was meant to protect. A partial unique index is the correct tool.

### 3.3 Why one `Node` table

Files and folders share a parent, a name, a position in the tree, and a uniqueness rule.
Splitting them would duplicate the path machinery, make listing a folder a UNION, and
make the name-uniqueness constraint unenforceable at the database level.

### 3.4 Why a materialized path

`path` holds the ids of a node's ancestors, root first, delimited and terminated by `/`:
`/rootId/financialsId/`. It is maintained on create and on move.

Everything expensive collapses into a prefix scan:

- Subtree listing, delete, and rollup: `path LIKE '/rootId/financialsId/%'`
- Share inheritance: a node's ancestors are already in `path`, so the access check is one
  flat query rather than a walk to the root on every request
- Breadcrumbs: split `path` in the caller and fetch by `id IN (...)` — no recursion

A string path rather than `uuid[]`: `path LIKE 'prefix%'` is expressible as Prisma's
`startsWith`, which keeps every subtree query inside the typed query builder instead of
`$queryRaw`. The prefix-collision worry (`/a/ab` matching `/a/abc`) is eliminated by the
trailing slash, since ids are fixed-length and the delimiter closes the prefix. No escaping
is needed because a path contains only UUIDs and slashes. A btree prefix scan is also
cheaper than GIN array containment.

Considered and rejected:

- **Pure adjacency with `WITH RECURSIVE`** — cleanest schema, but the access check on
  every single request becomes a recursive CTE, and so do breadcrumbs. It is the first
  thing that would have to be replaced at 100k files.
- **Closure table** — the same read performance as a materialized path, at the cost of
  O(subtree × ancestors) row churn per move and a second table to keep honest.

The trade-off accepted: `path` is denormalized state. It is maintained in exactly one
service method (§4.4), covered by tests, and reconstructible from `parentId` if it ever
drifts.

### 3.5 Why every room has a root node

The root node makes `parentId` NULL in exactly one row per room and makes `Share.nodeId`
NOT NULL. Sharing a Data Room is sharing its root node, so authorization has one code
path instead of two, and share inheritance needs no special case. A nullable
`Share.nodeId` was considered and rejected for exactly this reason.

NULL `parentId` on roots also means the name-uniqueness index does not constrain root
names across different rooms, which is the desired semantics.

### 3.6 Invitations by email

`granteeEmail` is the grant key, so a person who has not registered yet can be invited;
the access check resolves through `User.email` (unique, lower-cased). This is a deliberate
choice, not an omission.

`granteeId` stays null unless something writes it deliberately. The original design filled it
on first successful access, and that was wrong: it puts a write inside the single read-path
authorization decision, doubling round trips on every viewer read and swallowing failures to
avoid breaking reads. Attribution belongs in an append-only audit event on the share path — the
`Share` row is the grant, not the log — so the column stays available for that and for the seed,
which sets it explicitly. Recorded as a trade-off rather than left as a promise the code does
not keep.

---

## 4. Backend design

### 4.1 Access resolution — one point

One guard accepts either a JWT (cookie or Bearer) or an `X-Share-Token` header and
produces:

```ts
type AccessContext = {
  role: 'OWNER' | 'VIEWER'
  scopeRootId: string   // cannot read above this node
  scopePath: string     // "/rootId/folderId/" — prefix applied to every query
  viaShareId?: string
}
```

Every repository method takes an `AccessContext` and applies
`path LIKE scopePath || '%' OR id = scopeRootId`. A share recipient cannot read outside
their scope because the query does not compose without it — not because a controller
remembered to check. Breadcrumbs are truncated at `scopeRootId`, so a guest sees the path
from the shared folder, not from the room root.

Check order:

1. JWT or share token invalid → **401**
2. Caller owns the room → `OWNER`, scope is the root node
3. Otherwise, one query. Ancestor ids come from splitting the node's `path`:
   ```sql
   SELECT s.role, s.id, s.node_id, n.path
   FROM "Share" s
   JOIN "Node"  n ON n.id = s.node_id
   WHERE s.node_id = ANY($ancestorIdsPlusSelf)
     AND s.revoked_at IS NULL
     AND ( (s.mode = 'PUBLIC_LINK' AND s.token_hash = $tokenHash)
        OR (s.mode = 'USER'        AND s.grantee_email = $callerEmail) )
   ORDER BY length(n.path) DESC   -- deepest grant wins, so the most specific role applies
   LIMIT 1;
   ```
   No row → **404**. Ordering by path length makes "most specific grant wins" a property of
   the query rather than a later refinement — which is what §9.3 relies on when a second
   role is introduced.
4. Self or any ancestor has `deleted_at IS NOT NULL` → **410**

Filters live in the query, not in JavaScript after the fetch.

### 4.2 Endpoints

**Auth**
```
POST /auth/register        { email, password, name }
POST /auth/login           → access JWT (15m) + refresh cookie (7d, httpOnly)
POST /auth/refresh
POST /auth/logout
GET  /auth/me
GET  /auth/google  →  GET /auth/google/callback     (registered only when env is set)
```

**Rooms**
```
GET    /rooms                       owned rooms + rollup
POST   /rooms            { name }   creates room + root node in one transaction
PATCH  /rooms/:id        { name }   renames room and root node together
DELETE /rooms/:id
GET    /rooms/shared-with-me
```

**Nodes**
```
GET    /rooms/:roomId/nodes?parentId=&cursor=&limit=50&sort=name|updatedAt|size
       → { items[], nextCursor, breadcrumbs[], parent }
POST   /rooms/:roomId/folders        { parentId, name }
PATCH  /nodes/:id                    { name }
POST   /nodes/:id/move               { targetParentId }
GET    /nodes/:id/deletion-preview   → { folders, files, bytes, activeShares }
DELETE /nodes/:id
GET    /nodes/:id/rollup             → { folders, files, bytes }
GET    /rooms/:roomId/search?q=&cursor=
```

Listing returns breadcrumbs and parent in the same response, so neither owner nor guest
needs a second round trip to render the header.

**Upload — two phase**
```
POST /rooms/:roomId/uploads/presign
     { parentId, name, sizeBytes, mimeType, onConflict?: 'NEW_VERSION' | 'KEEP_BOTH' }
     → 200 { nodeId, uploadUrl, blobKey, expiresAt, versionNo }
     → 409 { code: 'NAME_CONFLICT', existingNodeId, currentVersionNo, existingUpdatedAt }
            when onConflict is absent

PUT  <uploadUrl>                     direct to bucket, XHR upload.onprogress
POST /uploads/:nodeId/confirm        → 200 { node }
```

**Files**
```
GET  /nodes/:id/content?version=              → 302 to a 5-minute presigned GET, inline
GET  /nodes/:id/versions
POST /nodes/:id/versions/:versionId/restore   → makes an old version current under a new number
```

A 302 rather than a proxy: the bucket serves the bytes and the API stays stateless. The
short TTL keeps a URL copied from DevTools from becoming a permanent public link.

**Sharing**
```
GET    /nodes/:id/shares
POST   /nodes/:id/shares   { mode: 'PUBLIC_LINK' }        → { url }, token shown once
POST   /nodes/:id/shares   { mode: 'USER', email }
DELETE /shares/:id                                         revoke — sets revokedAt
GET    /shared/:token                                      → { node, roomName, role }
```

Tokens are 32 random bytes, base64url. Only `sha256(token)` is stored; lookup by hash is
still a single indexed query because the hash is deterministic. The token is displayed
once at creation — losing the link means creating a new one, which is more honest than
pretending it can be recovered.

Revoking sets `revokedAt` instead of deleting the row, so the record of who was granted
access survives, and re-inviting the same address is an upsert on
`@@unique([nodeId, granteeEmail])`.

### 4.3 Error semantics

| Code | Condition | Why not something else |
|---|---|---|
| 401 | missing or expired credentials | — |
| 404 | node exists but the caller has no access | 403 would confirm existence and leak the structure of someone else's Data Room |
| 403 | access exists, role insufficient (VIEWER attempts a write) | existence is already known here; nothing left to hide |
| 410 | an ancestor was deleted; link revoked | the owner-deletes-a-shared-folder case deserves "deleted by the owner", not a silent 404 |
| 409 | name conflict on rename/move/upload; move into own descendant | — |
| 413 / 415 | over 50 MB / not `application/pdf`, caught at confirm | — |
| 422 | validation (empty name, `/` in name, over 255 chars) | — |

A revoked link returns 410, not 404: the token is unguessable, so telling its holder that
it is no longer active reveals nothing, and the UX difference is large.

### 4.4 Move — one transaction

```ts
await prisma.$transaction(async (tx) => {
  // Lock both rows so a concurrent move cannot slip between the check and the update
  const [src, dst] = await tx.$queryRaw`
    SELECT id, room_id, path, name, type FROM "Node"
    WHERE id IN (${sourceId}, ${targetParentId}) FOR UPDATE`

  if (dst.id === src.id) throw Conflict('CYCLE')
  if (dst.path.startsWith(src.path + src.id + '/')) throw Conflict('CYCLE')
  if (dst.type !== 'FOLDER' || dst.room_id !== src.room_id) throw Conflict('INVALID_TARGET')

  const oldPrefix = src.path + src.id + '/'
  const newPrefix = dst.path + dst.id + '/' + src.id + '/'

  // Descendants
  await tx.$executeRaw`
    UPDATE "Node"
    SET path = ${newPrefix} || substring(path from ${oldPrefix.length + 1})
    WHERE room_id = ${src.room_id} AND path LIKE ${oldPrefix + '%'}`

  // The node itself — its own path holds ancestors only, so the prefix filter above
  // does not match it
  await tx.node.update({
    where: { id: sourceId },
    data:  { parentId: dst.id, path: dst.path + dst.id + '/' },
  })
})
```

A destination name conflict is caught by the partial unique index and surfaced by mapping
Prisma `P2002` to 409 — the database is the authority, not a pre-check that races.

### 4.5 Rollup

No recursion. One aggregate over the prefix index:

```sql
SELECT count(*) FILTER (WHERE type = 'FILE')   AS files,
       count(*) FILTER (WHERE type = 'FOLDER') AS folders,
       coalesce(sum(size_bytes), 0)            AS bytes
FROM "Node"
WHERE room_id = $1 AND path LIKE $2
  AND deleted_at IS NULL AND status = 'ACTIVE';
```

`sizeBytes` is denormalized onto `Node` from the current version specifically so this
aggregate never joins `FileVersion`.

`BigInt` does not survive `JSON.stringify`, so a global interceptor serializes it as a
number (safe: 2^53 bytes is 9 petabytes) and the generated frontend types follow. Left
unhandled this throws at runtime on the first folder listing, not at compile time.

### 4.6 Delete

One `UPDATE ... SET deleted_at = now() WHERE room_id = $1 AND path LIKE $prefix` over the
whole subtree, plus the node itself. The tombstone is applied to every descendant, not
only the subtree root — otherwise name search would surface children of a deleted folder.

Soft delete is an internal mechanism: referential safety plus the 410 case for guests.
**There is no trash UI**; from the user's perspective deletion is permanent. Blobs remain
in the bucket and are removed by the sweep (§4.7); the README says so rather than
offering a Restore button that does nothing.

`DELETE /rooms/:id` is the same operation applied to the room's root node, so a room delete
tombstones its whole tree through one prefix UPDATE and revokes nothing explicitly — every
share beneath it stops resolving via the ancestor `deleted_at` check in §4.1 step 4.

`GET /nodes/:id/deletion-preview` returns folder count, file count, total bytes, and the
number of active shares that will stop working, so the confirmation dialog can state what
is actually being destroyed — including "3 people lose access".

### 4.7 Orphaned uploads

`presign` creates the `Node` with `status = PENDING` *before* handing out the URL, so the
client knows `nodeId` immediately and can render an optimistic row. If the browser closes
between PUT and confirm, the blob exists with no active row.

Blob keys are `rooms/{roomId}/nodes/{nodeId}/v{versionNo}` — derived, never client-supplied,
so a key cannot be guessed into another room and the sweep can reconstruct a key from a row.

- `PENDING` nodes are excluded from every listing, for everyone.
- An hourly `@Cron` deletes `PENDING` nodes older than 24 hours along with their blobs. This
  is the mechanism; there is no second one.

Writing uploads under a `pending/` prefix and copying to the final key on confirm was
considered — it would let a bucket lifecycle rule clean up without any application code.
Rejected: a server-side copy of every uploaded file doubles storage traffic on the happy
path to save a cron job on the rare one.

`confirm` is idempotent: called again on an `ACTIVE` node it returns the same result
without creating another version.

`confirm` does not trust the client. It issues a `HEAD` against `blobKey` and reads
`content-length` and `content-type` from the response:

- object missing → **409** `UPLOAD_NOT_FOUND`, node stays `PENDING`, the client may retry
- over 50 MB → delete the object, mark the node deleted, **413**
- not `application/pdf` → delete the object, **415**

This is the only place a size cap can be enforced: a presigned PUT cannot constrain
content length (`content-length-range` exists only in POST policies). So the HEAD is not
merely about a truthful `sizeBytes` — without it, subtree size totals are whatever the
client claimed.

---

## 5. Frontend design

### 5.1 Routes

```
/login  /register
/                              dashboard: owned rooms + "Shared with me"
/rooms/:roomId                 room root
/rooms/:roomId/f/:nodeId       folder
/rooms/:roomId/file/:nodeId    file view + version drawer
/s/:token                      public-link guest
```

A public-link guest and a signed-in user with a USER grant render the same pages. One
`AccessProvider` supplies `{ role, scopeRootId }` and components read `role` from
context. There is no `if (isGuest)` scattered through the tree — only an `<OwnerOnly>`
wrapper where a mutation would be.

### 5.2 Components

```
FileBrowser                  breadcrumbs + toolbar + table + drawer
  Breadcrumbs                left-bounded by scopeRootId
  BrowserToolbar             New folder / Upload / Search / sort — rendered per role
  NodeTable                  virtualized with @tanstack/react-virtual above ~200 rows
    NodeRow                  icon, name, size, date, RowActions
      RowActions             Rename / Move / Share / Download / Delete
    NodeTableEmpty           distinct copy: empty folder / no search results / guest
    NodeTableSkeleton
  DropZoneOverlay            OS file drop across the whole browser
  UploadQueuePanel           bottom-right, collapsible
    UploadQueueItem          progress, cancel, retry, error
  dialogs/
    CreateFolderDialog
    RenameDialog             inline validation, conflict check on blur
    MoveDialog               folder tree, own descendants disabled
    DeleteDialog             loads deletion-preview
    ShareDialog              Link / People tabs
    ConflictDialog
  FileViewer                 iframe on /nodes/:id/content
    VersionHistoryDrawer
```

`NodeRow` is presentational and issues no requests. Mutations live in hooks
(`useRenameNode`, `useMoveNode`, `useDeleteNode`), each owning its optimistic update and
its rollback. That is what makes the components granular in substance rather than merely
small.

### 5.3 Upload queue

A zustand store, because the queue must outlive route changes — the user should be able to
navigate while uploads continue.

```ts
type UploadTask = {
  id: string
  file: File
  parentId: string
  nodeId?: string
  status: 'queued' | 'presigning' | 'uploading' | 'confirming' | 'done' | 'error' | 'canceled'
  progress: number
  error?: string
  xhr?: XMLHttpRequest
}
```

- Concurrency 3; the rest wait in `queued`.
- `XMLHttpRequest`, not `fetch`: `upload.onprogress` reports real bytes, and upload
  progress is not portably available from `fetch`.
- Cancel calls `xhr.abort()`; the node stays `PENDING` and the sweep collects it.
- Retry restarts from `presign`, since the presigned URL may have expired.
- `beforeunload` warns while tasks are active.
- On confirm, the destination folder's query is invalidated. If the user has navigated
  away, no row flickers — a toast with "Reveal" takes them there.

### 5.4 Drag and drop — two different mechanisms

**Files from the OS** — native `DataTransfer` on the browser container.
`dragenter`/`dragleave` are counted, otherwise the overlay flickers over child elements.
OS folders (`webkitGetAsEntry`) are not supported, and the overlay says "Drop PDFs here"
rather than implying otherwise.

**Row onto folder** (move) — native HTML5 drag and drop, not `@dnd-kit`: a row is dragged
onto another folder row or onto a breadcrumb segment. Dropping onto itself or its own
descendant sets `dropEffect = 'none'` and shows no highlight, so cycles are prevented in
the UI before a request is made; the 409 from the backend is the second line of defence,
not the primary one.

### 5.5 Name conflicts

`presign` without `onConflict` returns 409 carrying `existingNodeId` and
`currentVersionNo`. The UI shows:

> **invoice.pdf already exists in Financials**
> Uploaded 2 days ago · currently v2
> [ Upload as new version (v3) ] [ Keep both — invoice (2).pdf ] [ Skip ]
> ☐ Apply to all 4 remaining conflicts

"Same name means a new version" is a good mechanic, but it silently assumes the same name
means the same document — a user uploading a different `invoice.pdf` would have their file
become v2 of someone else's. The dialog is what makes it a feature rather than a bug that
resembles one. "Apply to all" matters because twenty dropped files must not mean twenty
dialogs.

`KEEP_BOTH` generates `invoice (2).pdf`, skipping suffixes already taken.

### 5.6 States

| State | What the user sees |
|---|---|
| empty folder, owner | illustration + "Drop PDFs or create a folder" |
| empty folder, guest | "This folder is empty", no call to action |
| no search results | `No files match "xyz"` + Clear |
| loading | skeleton rows, not a spinner — no layout shift |
| 404 | "Not found or you don't have access" — one wording for both causes, so existence is not leaked |
| 410, owner deleted it under a guest | full-page "This item was deleted by the owner" + link to the share root if it is still alive |
| revoked link | "This link is no longer active" |
| offline / API down | "Reconnecting…" banner, TanStack Query retry with backoff, queued mutations survive |
| expired access JWT | silent refresh in the interceptor, one retry, then redirect to `/login?returnTo=` |

### 5.7 PDF viewing

`<iframe src="/nodes/:id/content">` following the 302 to a presigned GET. The browser's
native viewer provides zoom, search, and printing for free with no dependencies.
`react-pdf` would allow a custom toolbar at the cost of a pdf.js worker in the bundle and
hand-rolled pagination — not worth it when the requirement is "view file in UI". If the
iframe has not loaded after 5 seconds, a card offers "Open in new tab".

---

## 6. Testing

Tests follow risk, not coverage. Four units are written test-first:

| Unit | Why |
|---|---|
| `AccessResolver` | The most expensive possible bug: leaking another owner's Data Room. Cases: owner; USER grant on an ancestor; public link; revoked share; deleted ancestor → 410; attempt to read above `scopeRootId` |
| `MoveService` | Prefix arithmetic. Cases: move into a descendant → 409; move onto itself; deep subtree; destination name conflict; idempotency |
| `UploadConfirmService` | The only enforcement point. Cases: HEAD misses; over 50 MB; wrong MIME; repeat confirm; conflict → new version vs KEEP_BOTH |
| `NameConflictResolver` | `invoice (2).pdf` generation when `(2)` is already taken |

Integration tests use supertest against a real PostgreSQL (docker-compose locally, a
service container in CI), with the schema applied by `prisma migrate deploy`. A real
database is required, not SQLite: the partial unique index and `SELECT ... FOR UPDATE` are
the things most worth verifying and neither exists on a mock.

Frontend: vitest over the upload-queue reducer (concurrency, cancel, retry) — a real state
machine with real bugs. Per-dialog component tests are not written, and the README says so
instead of implying a full pyramid.

---

## 7. Deployment

### 7.1 The cross-site cookie problem, solved up front

With the frontend on `*.vercel.app` and the API on `*.up.railway.app`, the refresh cookie
would need `SameSite=None; Secure`, and Safari and Chrome restrict third-party cookies.
Login would break for some reviewers and not others.

Fixed without buying a domain, with a Vercel rewrite:

```json
{ "rewrites": [{ "source": "/api/:path*", "destination": "https://<api>.up.railway.app/:path*" }] }
```

Every browser request is then first-party to `*.vercel.app` and the cookie is
`SameSite=Lax; Secure; HttpOnly`. The Railway URL remains directly reachable, which
satisfies the "publicly accessible backend" requirement and serves `/docs`.

### 7.2 Pieces

Railway: PostgreSQL, bucket, API service. `prisma migrate deploy` runs as the release
command; healthcheck on `/health`.

CORS on the API allows the Vercel origin and `localhost:5173`, needed for direct calls and
for `/docs`. Separately, **CORS on the bucket** must allow `PUT` from the frontend origin
and expose `ETag` — otherwise presigned upload fails in the browser while working
perfectly from curl.

### 7.3 Environment

```
api:  DATABASE_URL  JWT_SECRET  REFRESH_SECRET
      S3_ENDPOINT  S3_BUCKET  S3_ACCESS_KEY_ID  S3_SECRET_ACCESS_KEY
      PUBLIC_APP_URL
      GOOGLE_CLIENT_ID?  GOOGLE_CLIENT_SECRET?
web:  VITE_API_BASE_URL=/api
```

### 7.4 Order of work

Deployment happens **first**, on a bare Nest app exposing `/health`. Otherwise the
discovery that cookies do not cross domains arrives in the eighth hour, which is not the
hour to debug it.

---

## 8. Seed data

`pnpm seed` creates:

- `demo@dataroom.app / demo1234` — owner of **"Project Titan — Acme Acquisition"**, with a
  realistic tree (`01 Corporate/`, `02 Financials/FY23/`, `03 Legal/Contracts/`, `04 IP/`)
  and roughly 25 PDFs generated with `pdf-lib` — real files in the bucket, not placeholders
- `counsel@example.com / demo1234` — holds a USER grant on `03 Legal/` and nothing else,
  so a reviewer can sign in and see scope actually truncate the tree
- an active public link on `02 Financials/FY23/`, with the URL in the README, so the guest
  flow can be checked without registering
- one file with three versions, so version history is not empty

Both credentials and the guest link appear at the top of the README. A reviewer should see
the product in ten seconds without creating an account.

---

## 9. How it scales

### 9.1 Total size and item count of a folder subtree

One aggregate over the `(room_id, path varchar_pattern_ops)` index — the query in §4.5. No
recursion, no join, one index range scan. `sizeBytes` is denormalized onto `Node` from the
current version so the aggregate never touches `FileVersion`.

When subtrees reach millions of nodes and rollups are requested per row rather than per
page, the next step is denormalized counters on folders maintained by trigger or outbox.
That change is cheap precisely because the rollup is already isolated behind one query.

### 9.2 One Data Room holding 100,000 files

**Listing** is always one folder, never the whole room. Keyset pagination on
`(parentId, name, id)` — `WHERE parent_id = $1 AND (name, id) > ($2, $3) ORDER BY name, id
LIMIT 50` — stays constant-time as the room grows, unlike `OFFSET`, which reads and
discards.

**Two indexes, because they serve two different queries.** `(parent_id, name, id)` is a
btree and provides the ordering, which is why listing does not sort. The path index serves
prefix scans for subtree work. A GIN index cannot supply `ORDER BY` at all, so it could
never have covered listing — which is exactly why both exist rather than one.

**Search** uses the `pg_trgm` GIN index on `name`, scoped by `roomId` and by the caller's
`scopePath`, so a share recipient's search cannot reach outside their scope.

**Client** virtualizes rows above ~200 with `@tanstack/react-virtual`, so a 5,000-file
folder renders 20 DOM rows.

**Deletes and moves** touch a subtree with a single UPDATE over the prefix index rather
than N statements.

### 9.3 Per-user roles (viewer/editor) without remodeling

`Share.role` is already an enum, and `AccessResolver` already returns a role rather than a
boolean. Adding an editor is: add `EDITOR` to the enum, and have the guard compare the
resolved role against the role a route requires. No change to `Node`, to `path`, to the
access query, or to any listing query — the tree and the permission grant were never
entangled.

Because a grant is attached to a node and inherited by prefix, a future "editor on
`03 Legal/`, viewer on the rest of the room" needs no new table either: it is two rows in
`Share`, and the resolver already takes the most specific matching grant.

---

## 10. Edge cases

| Case | Behaviour |
|---|---|
| Two files uploaded with the same name in one folder | Dialog: new version, keep both with a `(2)` suffix, or skip; "apply to all" for bulk drops |
| Same name differing only in case | Treated as a conflict — `lower(name)` in the unique index |
| Owner deletes a folder a guest is currently viewing | Guest's next request returns 410 with "deleted by the owner" and a link to the still-live share root |
| Move a folder into its own descendant | Blocked in the UI (`dropEffect = 'none'`, disabled in `MoveDialog`) and rejected with 409 by the transaction |
| Two concurrent moves of the same node | `SELECT ... FOR UPDATE` on both endpoints serializes them |
| Browser closed between PUT and confirm | Node stays `PENDING`, invisible to listings, collected by the hourly sweep and by the bucket lifecycle rule |
| Client lies about file size or type | Ignored — confirm reads both from a HEAD against the bucket and enforces there |
| Share revoked while a guest has the page open | Next request returns 410, "This link is no longer active" |
| Guest tries to navigate above the shared folder | Impossible: breadcrumbs stop at `scopeRootId` and queries carry the scope prefix |
| Access token expires mid-session | Interceptor refreshes silently and retries once, then redirects with `returnTo` |
| Invite an email that has no account yet | Grant is stored against the address and resolves when that user registers |
| Renaming a file to an existing name | 409 from the partial unique index, surfaced inline in the dialog |

---

## 11. Trade-offs and what is next

**Accepted:** `path` is denormalized (maintained in one place, tested); soft delete has no
user-facing restore; blobs outlive their rows until the sweep runs; only PDFs; only a
viewer role; no audit log; no OS folder upload.

**Next, in order:** blob deletion in the same sweep pass as PENDING cleanup; the editor
role (§9.3); an audit log of share access, which the `Share`/`granteeId` pair already
supports; per-share expiry; folder upload via `webkitGetAsEntry`.

---

## 12. README outline

1. Live URLs — frontend, backend, Swagger — plus demo credentials and the guest link
2. What it does — screenshots or a 30-second GIF of the core flow
3. Local setup — `pnpm i`, `docker compose up`, `.env.example`, migrate, seed; must work
   from a clean clone
4. Architecture — web → Vercel rewrite → Nest → Postgres + bucket, and the two-phase upload
5. Data model — mermaid ERD, plus why one `nodes` table, why a materialized path, why a
   root node
6. Authorization — `AccessContext`, the single access query, the error-code table and why
   404 rather than 403
7. How it scales — the three answers from §9, with the SQL quoted verbatim
8. Edge cases — the table from §10
9. Trade-offs and what is next — §11
10. Where AI was used — specifically: what was generated, what was rewritten by hand, and
    where the first generated answer was **wrong** and was caught. The `path` arithmetic in
    move and the NULL semantics of a partial unique index are both such places; two
    concrete sentences there are worth more than a paragraph of generalities.
