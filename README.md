# Data Room

A due-diligence data room: an owner creates a room, organizes folders and PDFs inside it,
and shares any folder or file — either as a public link or with a named email address —
without exposing anything above what was shared. Guests get a browser that starts at the
shared node and has no way up, no mutation controls, and no knowledge that the rest of the
room exists. Revocation is immediate.

- **API** — NestJS 11, Prisma 7 (driver adapter), PostgreSQL 16, S3-compatible object
  storage (MinIO locally, Tigris in production).
- **Web** — React 19, Vite 8, TanStack Query 5, Tailwind 4, react-router 7, zustand.
- **Monorepo** — pnpm workspaces, `apps/api` and `apps/web`. No Turborepo, no shared
  package: the frontend's only knowledge of the API is `apps/web/src/api/schema.d.ts`,
  generated from the emitted `openapi.json`.

## What is built

| Requirement | Where |
| --- | --- |
| Email/password auth, and Google | `/login`, `/register`; Google button appears when the API has credentials |
| Folder create, rename, move, delete — with breadcrumbs | Room browser; breadcrumbs are clickable and double as drop targets |
| Delete warns what goes with it | Counts the whole subtree — folders, files, bytes, and how many live shares stop working |
| Upload PDFs: many at once, drag-and-drop, per-file progress | Drop anywhere in the browser; three concurrent uploads, one progress bar per file, one conflict prompt per batch |
| View a file in the browser | `GET /nodes/:id/content` → 302 to a 5-minute presigned URL |
| Rename / move / delete a file | Row menu, or drag a row onto a folder or a breadcrumb |
| Share a room, folder or file — public link or by email, read-only, revocable | Share dialog; guests land in a scoped browser with no way up |
| **Extra credit** — file versioning with history and restore | "Add a version" on a name conflict; history panel in the viewer |
| **Extra credit** — search by filename | Search box in the browser, scoped to the caller's subtree |

Deliberately absent, per the spec: no trash or restore UI (soft delete is a tombstone the
API respects, not a user-facing bin), no audit log, no OS folder upload, no editor role —
though the model already carries roles, see [How it scales](#how-it-scales).

## Live

| | |
| --- | --- |
| Web app | https://data-room-app-sage.vercel.app |
| API docs (Swagger) | https://api-production-f651.up.railway.app/docs |

The browser only ever talks to the Vercel origin: `vercel.json` rewrites `/api/*` to the
Railway host, so every request is first-party and the `SameSite=Lax` refresh cookie
survives. The same prefix is proxied in Vite's dev server, so local and production behave
identically.

`vercel.json` also carries a catch-all rewrite to `/index.html`; without it a reload on a
client route like `/rooms/<id>` would 404, since only `/` exists as a file. Vercel serves
static assets before consulting rewrites, so the catch-all cannot shadow them.

The bucket's CORS allow-list holds both origins (the Vercel one and `http://localhost:5173`)
for `PUT`, `GET` and `HEAD` — `PUT` because the browser uploads straight to the bucket
through a presigned url, `GET`/`HEAD` because the viewer follows the API's 302 into the
bucket to read bytes.

### Demo credentials

Created by `pnpm seed`, which prints them along with a fresh public link:

| Account | Password | Sees |
| --- | --- | --- |
| `demo@dataroom.app` | `demo1234` | The whole room — "Project Titan — Acme Acquisition", 8 folders, 24 PDFs |
| `counsel@example.com` | `demo1234` | Only `03 Legal`, through a named VIEWER grant |

The seed also creates a public link scoped to `02 Financials/FY23` and prints it as
`<PUBLIC_APP_URL>/s/<token>`. The token is random per run and only the hash is stored, so
it cannot be recovered afterwards — re-run `pnpm seed` to mint a new one.

## Local setup

From a clean clone (Node 20+, pnpm 9+, Docker):

```bash
pnpm install                                  # postinstall runs `prisma generate`
cp .env.example apps/api/.env                 # apps/web needs no env file
pnpm infra:up                                 # Postgres on :5433, MinIO on :9000 + bucket
pnpm --filter api exec prisma migrate deploy
pnpm seed                                     # prints the credentials and the guest link
pnpm dev                                      # api on :3000 (/docs), web on :5173
```

Sign in at http://localhost:5173 as `demo@dataroom.app` / `demo1234`.

Tests:

```bash
pnpm --filter api test                        # 76 unit tests, no database needed
pnpm --filter web test                        # 162 component/hook tests (vitest, jsdom)

# Every e2e spec truncates every table, so the suite runs against its own database and
# refuses to start unless DATABASE_URL names one whose name ends in `_test`
# (apps/api/test/support/require-test-database.ts). Set it up once:
cp apps/api/.env.test.example apps/api/.env.test
docker compose exec -T postgres createdb -U dataroom dataroom_test
DATABASE_URL="postgresql://dataroom:dataroom@localhost:5433/dataroom_test?schema=public" \
  pnpm --filter api exec prisma migrate deploy
pnpm --filter api test:e2e                    # 158 e2e tests against Postgres + MinIO
```

`.env.test` is a real env file and stays gitignored, like `.env`;
`apps/api/.env.test.example` is the committed template and can be copied verbatim. Skip
that step and the suite aborts with the commands above rather than falling back to
`apps/api/.env` — which is the development database, and which a green run would empty.

`pnpm infra:down` stops the containers and drops their volumes. CI
(`.github/workflows/ci.yml`) runs exactly these commands against the same
`docker-compose.yml`, rather than a second copy of the service definitions.

## Architecture

```
browser ──/api/*──> Vercel rewrite ──> Nest (Railway) ──> Postgres
   │                                        │
   │                                        └─ presigned PUT/GET urls
   └────────────── bytes ─────────────────> S3-compatible bucket
```

File bytes never pass through the API. Upload is two-phase:

1. `POST /rooms/:roomId/uploads/presign` — the API creates the `Node` (`status: PENDING`)
   and its `FileVersion` row, derives the blob key server-side as
   `rooms/{roomId}/nodes/{nodeId}/v{versionNo}`, and returns a 15-minute presigned PUT.
2. The browser PUTs straight to the bucket, then calls
   `POST /uploads/:nodeId/confirm`. Confirm HEADs
   the object, and only then flips the node to `ACTIVE` — recording the **measured** size,
   the **measured** content type, and the ETag as `FileVersion.checksum`.

Why it matters:

- A 50 MB PDF never occupies an API request body, so the API needs no large body limit, no
  multipart buffering and no disk; a single small instance serves uploads of any size the
  bucket accepts.
- The key is derived from ids the server already trusts, so a client cannot aim an upload
  at another room's key space.
- The size cap, the MIME check and the zero-byte check live in `confirm`, not in presign,
  because a presigned PUT *cannot* constrain content length — `content-length-range`
  exists only in POST policies. Presign checks what the client *claims*; confirm checks
  what actually landed, and rejects it by deleting the blob and tombstoning the node. The
  zero-byte rejection is there because `sizeBytes = 0` is exactly how the read path
  recognises an *unconfirmed reservation*: an accepted empty upload would leave an ACTIVE
  node pointing at a version the API skips forever, listing fine and 404ing in the viewer.
- The ETag is not decoration. The presigned PUT stays valid for ~15 minutes after confirm,
  so the object can be overwritten behind the API's back. Every read HEADs the object again
  and compares; a mismatch — **or a version with no recorded checksum at all** — is 410,
  never a redirect to unverified bytes. (This is also why the seed stores the ETag it gets
  back from its own HEAD: a seeded file with a null or invented checksum is a 410 in the
  viewer.)

Reads are the same trick in reverse: `GET /nodes/:id/content` authorizes, then answers
**302** to a 5-minute presigned GET with `Content-Disposition: inline`. The viewer follows
the redirect into the bucket.

## Data model

```mermaid
erDiagram
    User ||--o{ DataRoom : owns
    DataRoom ||--|| Node : "root node"
    DataRoom ||--o{ Node : contains
    Node ||--o{ Node : "parent of"
    Node ||--o{ FileVersion : "has versions"
    Node ||--o{ Share : "granted through"

    User {
        uuid id PK
        string email UK "always stored lower-cased"
        string passwordHash "null for a Google-only account"
        string googleId UK "null until Google is linked"
        string name
        datetime createdAt
    }

    DataRoom {
        uuid id PK
        uuid ownerId FK "-> User.id, cascade"
        string name
        uuid rootNodeId UK "-> Node.id, no FK: written in the same transaction as the node"
        datetime createdAt
    }

    Node {
        uuid id PK
        uuid roomId FK "-> DataRoom.id, cascade"
        uuid parentId FK "-> Node.id, cascade; null only on a root node"
        enum type "FOLDER | FILE"
        string name
        string path "materialized ancestors: '/' at the root, '/rootId/folderId/' below"
        enum status "PENDING until an upload is confirmed, then ACTIVE"
        uuid currentVersionId UK "-> FileVersion.id, no FK: would be circular"
        bigint sizeBytes "denormalized from the current version"
        datetime deletedAt "tombstone; null means live"
        uuid createdById
        datetime createdAt
        datetime updatedAt
    }

    FileVersion {
        uuid id PK
        uuid nodeId FK "-> Node.id, cascade"
        int versionNo "unique per node"
        string blobKey "rooms/{roomId}/nodes/{nodeId}/v{versionNo}, always server-derived"
        bigint sizeBytes "measured by a bucket HEAD, never client-reported"
        string mimeType "application/pdf"
        string checksum "ETag verified at confirm; re-checked before every read"
        uuid createdById
        datetime createdAt
    }

    Share {
        uuid id PK
        uuid nodeId FK "-> Node.id, cascade; a whole room is shared via its root node"
        enum mode "PUBLIC_LINK | USER"
        enum role "VIEWER (the enum exists so EDITOR is one value, not a redesign)"
        string tokenHash UK "sha256 of the link token; the token itself is never stored"
        string granteeEmail "set for USER shares, so an invite works before registration"
        string granteeId "resolved user, when the address already has an account"
        uuid createdById
        datetime createdAt
        datetime revokedAt "null means live; revocation is never a delete"
    }
```

The index table — including the three hand-written ones below — is in
**[docs/erd.md](docs/erd.md)**.

Folders and files are one table. A `Node` is a `FOLDER` or a `FILE`; only files have
`FileVersion` rows. Two tables would have duplicated every listing, rename, move, delete
and share query, and made "one name per folder, whatever its type" impossible to enforce in
the database.

### The materialized path

Each node stores its **ancestors** as a string: `/` at the root, `/{rootId}/{folderId}/`
below. The trailing slash is what makes prefix matching safe — ids are fixed length and the
delimiter closes the prefix, so `/a/ab/` can never match `/a/abc/`.

Chosen over the alternatives because the operations that matter are all subtree-shaped:

| Operation | With a materialized path | With `parentId` alone |
| --- | --- | --- |
| Subtree totals | one aggregate with `path LIKE '/root/fin/%'` | recursive CTE per call |
| Ancestors / breadcrumb | already in the row — `path.split('/')`, one `IN` query | one query per level |
| Delete a folder | one `UPDATE ... WHERE path LIKE prefix` | recursive walk |
| Move a folder | one `UPDATE` rewriting the prefix of every descendant | update one row, then re-walk to fix nothing (paths don't exist) but every read pays the recursion instead |

A `uuid[]` ancestor array was the other candidate. It loses on two counts: prefix
containment on an array needs a GIN index and cannot express "descendants of X, in name
order" as one index scan, and `LIKE 'prefix%'` on a text column is a plain btree range
scan — the cheapest access path Postgres has. The cost of the string is that a move must
rewrite descendants' paths; that is one `UPDATE` over an indexed prefix, and moves are
rare compared to reads.

Every room has a root node. Without it, "share the whole room" and "share this folder"
would be two different code paths with two different authorization stories; with it,
`Share.nodeId` covers both, and `isWholeRoom` is just `nodeId === room.rootNodeId`.

### The three hand-written indexes

`prisma/migrations/20260819141425_indexes/migration.sql` contains three indexes Prisma's
schema language cannot express. Each is also declared in `schema.prisma` in whatever form
Prisma *does* understand, because the diff engine proposes dropping any index it cannot
see.

```sql
CREATE UNIQUE INDEX node_name_uniq ON "Node" ("parentId", lower(name)) WHERE "deletedAt" IS NULL;
CREATE INDEX node_path_prefix ON "Node" ("roomId", path varchar_pattern_ops);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX node_name_trgm ON "Node" USING gin (name gin_trgm_ops);
```

1. **`node_name_uniq`** — Prisma has neither functional indexes (`lower(name)`) nor partial
   predicates (`WHERE "deletedAt" IS NULL`). Both halves are required: case-insensitive
   because `Report.pdf` and `report.pdf` are the same name to a user, and partial because a
   deleted node must not keep occupying its name forever. The database is the authority on
   conflicts — the services catch its unique violation and translate it to 409 rather than
   pre-checking, because a pre-check races.
2. **`node_path_prefix`** — the `varchar_pattern_ops` operator class. Prisma cannot attach
   an operator class to a btree index. Without it, `path LIKE 'prefix%'` does **not** use
   the index under any non-`C` collation, and every rollup, delete and move degrades to a
   sequential scan of the room.
3. **`node_name_trgm`** — Prisma can declare a GIN index with `ops: raw("gin_trgm_ops")`,
   but not `CREATE EXTENSION pg_trgm`, without which the operator class does not exist.
   The schema declaration and the SQL name must match (`map: "node_name_trgm"`), or
   `migrate dev` proposes dropping it.

## Authorization

Every route that touches a node or a room resolves one `AccessContext` in
`AccessResolver` — never re-derives it — so "can this caller see this row" has exactly one
implementation:

1. **Owner** — checked first, against `DataRoom.ownerId`. An owner's access never depends
   on a `Share` row existing. Scope is the whole room.
2. **Deepest grant wins** — the node's own `path` already lists its ancestors, so the
   candidate set is `[...ancestorIds(path), node.id]` and one query finds any live share on
   any of them, `ORDER BY length(n.path) DESC LIMIT 1`. The deepest match becomes the
   caller's scope root, and the caller's **role comes off that grant row** rather than
   being hard-coded. This is what makes overlapping grants well-defined, and what makes
   adding `EDITOR` a data change instead of a redesign.
3. **Tombstone check runs last.** A caller with no grant never reaches it.

Scope is then carried as `scopeRootId` / `scopePath` and ANDed into every listing,
breadcrumb, rollup, move and delete query. A guest cannot see, count, or affect a row
outside their subtree, because the SQL that would return it never matches.

### 404, never 403

| Situation | Status |
| --- | --- |
| No credentials at all | 401 |
| Node exists but the caller has no grant — or never had one | **404** |
| Caller has a grant, but their role is too weak for this action | 403 |
| Caller had access; the node or an ancestor is deleted | 410 |
| Public link revoked | 410 |
| Name collision, or a move that would create a cycle | 409 |
| Over 50 MB / not a PDF | 413 / 415 |
| Uploaded object is zero bytes | 422 `EMPTY_UPLOAD` |
| Bad request body | 422 |

A stranger who probes `GET /nodes/<uuid>` must not be able to tell "no such node" from
"a node you may not see". 403 answers that question; 404 does not. The distinction is
enforced at the source: `notFound()` is the single helper both cases throw, and the
deleted-ancestor check runs *after* access is confirmed — otherwise a 410 would itself
confirm that something used to exist there.

403 is reserved for a caller who **is** inside the room and whose role is insufficient
(today only the owner-only mutation routes), where existence is already known.

## How it scales

**Total size and file count of a folder, including everything below it.** One aggregate,
no recursion, no join:

```sql
SELECT count(*) FILTER (WHERE type = 'FOLDER')                     AS folders,
       count(*) FILTER (WHERE type = 'FILE')                       AS files,
       coalesce(sum("sizeBytes") FILTER (WHERE type = 'FILE'), 0)   AS bytes
FROM "Node"
WHERE "roomId" = $1 AND path LIKE $2 AND "deletedAt" IS NULL AND status = 'ACTIVE'
```

`sizeBytes` is denormalized from the current version onto `Node` precisely so this never
touches `FileVersion`, and `$2` is a prefix served by `node_path_prefix`. Next step if
rollups ever get hot: maintain counters on the folder rows by trigger. That is cheap to add
*because* the rollup is already a single query over a known prefix — the trigger writes the
same three numbers this query computes.

**A room with 100,000 files.** Nothing in the read path is proportional to room size:

- Listing is always **one folder**, keyset-paginated on `(sort_key, id)` and served by
  `Node_parentId_name_id_idx`, so page 500 costs what page 1 costs. No `OFFSET` — its cost
  grows with the offset, and it skips or repeats rows when a sibling is inserted mid-scroll.
- The frontend virtualizes above 200 rows (`NodeTable.tsx`), so a 20,000-child folder
  renders a screenful of DOM.
- Breadcrumbs are one `IN` query on ids the row already carries.
- Delete and move are each **one** `UPDATE` over an indexed prefix, not a walk.
- Rollups are the aggregate above.
- Two indexes exist on name because they answer two different questions: a btree can
  supply `ORDER BY name` but not substring matching; a GIN trigram index can supply
  substring matching but cannot order at all.

The honest limits: a folder with hundreds of thousands of *direct* children still returns
pages of that folder (fine), but a move of a very large subtree is one long `UPDATE` that
holds row locks for its duration — batching it is the next step. Bucket cost, not database
cost, is what actually grows with 100,000 files.

**Different roles per user.** Already modelled, not retrofitted. `Share.role` is a
Postgres enum, the resolver returns a *role* rather than a boolean, and overlapping grants
already resolve deepest-first. Adding `EDITOR` is:

1. one value on the `Role` enum (one migration),
2. one comparison in the guard that today asserts `OWNER` for mutations,
3. one more branch in the frontend's `role === 'OWNER'` checks.

No change to the tree, to `path`, to any listing query, or to the access resolver's shape.
Per-node roles are the same mechanism: a grant lives on a node, and the deepest one wins.

## Extra credit: both built

Both extra-credit features are implemented, and each one is where the interesting
constraints turned out to be.

- **File versioning.** Uploading a name that already exists offers "add a version"
  alongside "keep both". A new version is a new `FileVersion` row at `versionNo + 1`
  with its own blob key (`.../v{versionNo}`); the node stays `ACTIVE` on its current
  version until `confirm` succeeds, so an in-flight v2 never blanks a live v1. History
  is **append-only**: restoring an older version copies it *forward* under a new number
  rather than moving the pointer back, which is what lets the orphan sweep recognise an
  abandoned re-upload — a version numbered above `currentVersionId` with no confirmed
  bytes can only be one. Restore also copies the stored ETag, and it is worth being
  precise about why, because the obvious guess is backwards. A 410 is *not* what a
  dropped checksum used to cost: the read comparison was written as "compare only if a
  checksum was recorded", so a `null` on the restored row skipped the comparison
  entirely and the API answered **302 with unverified bytes** — the exact case the check
  exists to catch, silently disarmed, and strictly worse than any error status. A
  visible 410 tells the user their file is unopenable; a 302 tells them nothing and
  serves whatever is in the bucket. That tolerance is gone now (a version with no
  recorded checksum is refused outright), so a restore that dropped the ETag would fail
  loudly instead — but the reason to copy it was never tidiness.
- **Filename search.** `GET /rooms/:roomId/search` is a single query over the
  `node_name_trgm` GIN index, with the caller's scope applied **in SQL** — a share
  recipient's search cannot reach outside the subtree they were given, and that is
  tested at the service level, not only over HTTP, because an HTTP-only test would be
  satisfied by the access guard and would prove nothing about the query. `LIKE`
  metacharacters are escaped, so a query for `20%` matches the literal string.
  Pagination is keyset, inside the query, so `LIMIT` stays honest.

## Production caveats

Two known sharp edges, both real:

1. **The bucket's CORS allow-list must include the deployed web origin, with `GET`.** The
   viewer fetches file bytes and follows the API's 302 *into the bucket*, so the final
   request is a cross-origin request from the web origin to the storage host. Local MinIO
   allows it by default; Tigris does not until the origin is added. The symptom is a viewer
   that fails with a CORS error while `curl` on the same URL returns the PDF — so it looks
   like an auth bug and is not one.
2. **A rejected upload can leave an orphan blob.** The presigned PUT reaches the bucket
   directly, so bytes exist before the API has any say. If `confirm` rejects them (over
   50 MB, not a PDF, or zero bytes) the API deletes the object and tombstones the node —
   but if the browser never calls `confirm` at all, the object sits under a key whose
   `Node` is still `PENDING`. The hourly sweep deletes `PENDING` nodes older than 24 hours
   together with their blobs, which covers the abandoned-upload case; what it does not
   cover is a blob whose DB row was already removed by a failed rejection path.
   Reconciling the bucket against `FileVersion.blobKey` is the missing sweep.

## Where AI was used

This repository was built with Claude Code, working from six written plans
(`docs/superpowers/plans/`) derived from a single spec. The division of labor was
explicit: **I acted as the architect and reviewer** — setting the requirements, choosing
the stack and the deploy targets, approving or rejecting each design decision, reviewing
every PR before merge, and verifying the deployed app by hand. **Claude was the
instrument**: brainstorming design alternatives (materialized path vs. closure table,
two-phase upload, deepest-grant-wins), generating the code and the tests, and exercising
the running app — driving the browser through upload, move, delete and share flows to
confirm they work, not just compile.

The workflow was deliberately adversarial rather than "generate and hope":

- **Plan first, then execute task by task.** Each plan task named its files, its
  interfaces, and its test before any implementation. Tasks were dispatched to subagents
  with a fixed scope; the plan, not the model's improvisation, decided what got built.
- **Tests before implementation, and the failing run was recorded.** A test that passes on
  the first try is a test that may not be testing anything.
- **Review rounds were mutation-verified.** Instead of accepting "this is covered", the
  reviewer broke the implementation on purpose — flip a comparison, drop a `WHERE` clause —
  and confirmed a specific test went red. Several tests that passed against deliberately
  broken code were rewritten.
- **Every command in this README was run before it was written down**, including the seed
  and the `302`-not-`410` check on a seeded file.

Three places where the first generated answer was **wrong** and was caught, all of which
left a comment in the code:

1. **Move rewrote the wrong rows.** A node's `path` holds only its *ancestors*, so
   `WHERE path LIKE oldPrefix || '%'` matches the moved node's descendants but never the
   moved node itself. The first version silently left the moved row's own `path` stale.
   `MoveService` now updates the subtree and the node in two separate statements
   (`src/nodes/move.service.ts`).
2. **A unique constraint that enforced nothing.** `@@unique([parentId, name, deletedAt])`
   looks like it prevents duplicate live names. It does not: NULLs are distinct in
   Postgres, so every live row (`deletedAt IS NULL`) is unique against every other one, and
   the index never fires. The fix is a partial unique index on `lower(name)`, which Prisma
   cannot express — hence `node_name_uniq` in raw SQL.
3. **A silent path-corruption bug from an untyped parameter.** In the move `UPDATE`,
   `substring(path from $n)` without a cast let node-postgres send the offset untyped;
   Postgres then resolved the **regexp** overload of `substring(text FROM pattern)` instead
   of the positional one, writing back whatever substring happened to match those digits.
   It only corrupted paths when an id contained the offset's digits, which is why it took a
   reproduction rather than a review to find. The fix is the `::int` cast, and the comment
   explaining it is longer than the statement.

The seed data (`apps/api/src/seed/`) is generated: 24 real PDFs built with `pdf-lib`, not
placeholder bytes, because the viewer has to render them.
