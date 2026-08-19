# Data Room — Plan Set Overview

**Spec:** `docs/superpowers/specs/2026-08-19-data-room-design.md`

Six plans, executed in order. Each ends with working, testable software and its own review gate. Task numbers are continuous across the set, so a cross-reference like "the resolver from Task 9" is unambiguous.

| Plan | Tasks | Deliverable | Green when |
|---|---|---|---|
| [01 — Foundation, Auth and Deployment](2026-08-19-data-room-01-foundation.md) | 1–6 (3 → **3a** only) | Monorepo, local Postgres + MinIO, Nest error contract, schema with three raw SQL indexes, email/password + optional Google auth, **API deployed to Railway** | `curl https://<api-host>/health` → `{"status":"ok"}` and `/docs` renders; a user can register, sign in, read `/auth/me` |
| [02 — Tree API and Authorization](2026-08-19-data-room-02-tree-api.md) | 7–12 | Path/cursor/name primitives, rooms with root nodes, rollups, `AccessResolver`, folder listing with breadcrumbs and keyset pagination, move, delete with preview | An owner can do every folder operation; a viewer is scoped, gets 404 outside, 403 on writes, 410 under a tombstone |
| [03 — Files, Sharing and Search API](2026-08-19-data-room-03-files-sharing-api.md) | 13–17 | S3 storage service, two-phase upload with versioning and conflict strategies, file viewing, orphan sweep, shares with revocation, trigram search, `openapi.json` | Full API suite green; a PDF round-trips through presigned PUT and confirm |
| [04 — Web Shell, Auth and Dashboard](2026-08-19-data-room-04-web-shell.md) | 17b, 18–20 | Tailwind + Radix primitives, typed API client with one silent refresh, sign-in/registration, Data Room dashboard | Session survives a hard reload; rooms list with real subtree totals |
| [05 — File Browser, Uploads and Viewer](2026-08-19-data-room-05-web-browser.md) | 21–25 | Access context, node table with virtualization, create/rename/delete/move, drag-and-drop upload queue with progress and conflict prompt, PDF viewer with version history | Twenty dropped PDFs upload three at a time with one batched conflict decision |
| [06 — Sharing UI, Search, Seed and Release](2026-08-19-data-room-06-sharing-ui-release.md) | 26–30 | Share dialog, guest experience, search UI, seed data, CI, README | A reviewer opens the live URL, uses the seeded guest link, and watches revocation land |

## Execution order and why

Deployment comes before any feature. Cross-site cookie behaviour and bucket CORS are environment failures that cannot be reproduced locally, and finding them in the last hour is not a plan. Everything after that is ordered so each plan only depends on interfaces the previous one has already tested.

**Task 3 was split during execution.** Plan 01 owns **3a** — Railway: Postgres, an S3-compatible bucket, the api service, a public domain, and migrations running in a real environment. Plan 04 opens with **17b**, the Vercel half: `apps/web`'s scaffolding, `vercel.json`'s `/api` rewrite, the deploy, and the bucket CORS entry for the Vercel origin. The split happened because 3b needs a frontend to deploy and interactive Vercel authentication, and because nothing in plans 02 or 03 depends on it. It cost one thing worth naming: the `SameSite=Lax` refresh cookie is designed-for but unverified until 17b runs, so that verification is 17b's Step 6 rather than a later discovery.

What 3a already bought, before plans 02 and 03 were written: the presigned PUT → HEAD → GET → DELETE cycle verified against the production bucket, the discovery that Railway's Tigris-backed buckets use virtual-host addressing (so `S3_FORCE_PATH_STYLE` is `false` in production and `true` for MinIO locally), and two bugs that only a deploy could surface — `nest build` emitting `dist/src/main.js`, and a healthy container answering 502 because Railway injects `PORT` at runtime.

The one API change made late is in Task 27: `GET /nodes/:id/content` also accepts the share token as a query parameter, because an `iframe` cannot send a custom header. It is called out there rather than smuggled in.

## Spec coverage

| Spec section | Where it is implemented |
|---|---|
| §1 Scope, multiplicity | Task 8 (many rooms per user), Task 20 (dashboard) |
| §2 Stack, repo layout | Tasks 1, 2, 18 |
| §3.1–3.2 Schema, raw SQL indexes | Task 4 |
| §3.3 One `Node` table | Task 4 |
| §3.4 Materialized path | Task 7 (primitives), Tasks 10–12 (use) |
| §3.5 Root node per room | Task 8 |
| §3.6 Invitations by email | Task 16, Task 26 |
| §4.1 Access resolution | Task 9 |
| §4.2 Endpoints — auth | Tasks 5, 6 |
| §4.2 Endpoints — rooms | Task 8 |
| §4.2 Endpoints — nodes | Tasks 10, 11, 12 |
| §4.2 Endpoints — upload | Task 14 |
| §4.2 Endpoints — files, versions | Task 15 |
| §4.2 Endpoints — sharing | Task 16 |
| §4.3 Error semantics | Task 2 (`DomainError` map), asserted in Tasks 9–16 |
| §4.4 Move transaction | Task 11 |
| §4.5 Rollup | Task 8 |
| §4.6 Delete, deletion preview | Task 12 |
| §4.7 Orphaned uploads, HEAD enforcement | Tasks 14, 15 |
| §5.1 Routes | Tasks 19, 21, 25, 27 |
| §5.2 Components | Tasks 21–26 |
| §5.3 Upload queue | Task 24 |
| §5.4 Two drag-and-drop mechanisms | Tasks 23 (row → folder), 24 (OS files) |
| §5.5 Name conflicts | Task 14 (API), Task 24 (dialog) |
| §5.6 States | Task 18 (`ErrorState` wording), 21 (empty/skeleton), 27 (guest 410) |
| §5.7 PDF viewing | Task 25 |
| §6 Testing | Test-first steps throughout; risk-ranked units in Tasks 9, 11, 14, 24 |
| §7 Deployment, cookie fix, bucket CORS | Task 3a (Railway) + Task 17b (Vercel + rewrite) |
| §8 Seed data | Task 29 |
| §9 How it scales | Task 30 (README), mechanisms in Tasks 8, 10, 17 |
| §10 Edge cases | Asserted across Tasks 9–16 and 24; tabulated in Task 30 |
| §11 Trade-offs | Task 30 |
| §12 README outline | Task 30 |
| Extra credit — search | Task 17 (API), Task 28 (UI) |
| Extra credit — versioning | Task 14 (new versions), Task 15 (history, restore), Task 25 (UI) |

## Deliberate deviations from the spec

Both are improvements found while planning, and both belong in the README's AI section:

1. **`POST /uploads/:nodeId/confirm` takes `versionId` in the body** (Task 14). The spec's node-only form is ambiguous once a node has more than one version in flight; naming the version makes confirm idempotent.
2. **`GET /nodes/:id/content` accepts `?shareToken=`** (Task 27). An `iframe` cannot send `X-Share-Token`, so without this a guest could never read a PDF inline. The token already travels in the share URL, so nothing new is exposed.

## Verification gates

Do not advance to the next plan until its predecessor's suite passes:

```bash
docker compose up -d
pnpm --filter api test && pnpm --filter api test:e2e     # after plans 01, 02, 03
pnpm --filter web test && pnpm --filter web build        # after plans 04, 05, 06
```

Task 30 ends with a fourteen-point manual checklist against the live URLs. Record its actual results — a plan is not complete because its steps were read.
