# Data Room — Plan 06: Sharing UI, Search, Seed and Release

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan set:** this is one of six. Order: 01 foundation → 02 tree API → 03 files & sharing API → 04 web shell → 05 web browser → 06 sharing UI & release. See `2026-08-19-data-room-00-overview.md`.

**Goal:** Finish the product — share by link or by email with revocation, a guest experience that never leaks the rest of the Data Room, name search, demo data a reviewer can open in ten seconds, CI, and a README that argues the design.

**Architecture:** The guest route resolves a token once, stores it in the API client, and then renders the same browser components as the owner — the role from the listing response does the rest. One API adjustment is needed: an `iframe` cannot send a custom header, so `GET /nodes/:id/content` also accepts the share token as a query parameter.

**Tech Stack:** React 18, TanStack Query 5, NestJS 11, `pdf-lib` for seed documents, GitHub Actions.

**Prerequisite:** Plan 05 complete — browser, uploads and viewer working for an owner.

**Spec:** `docs/superpowers/specs/2026-08-19-data-room-design.md`

> **[VOID — RULING 34, 2026-08-20] The cut below was REVERSED by the user; search shipped after all.
> The block is kept only as a record of what was decided when. Do not implement from it.**
>
> **SCOPE CUT (Ruling 32, user-approved).** Extra credit is out of scope, so:
> - **Task 28 (Search) is DROPPED ENTIRELY.** There is no `GET /rooms/:roomId/search` endpoint —
>   it was cut from plan 03. Build no `src/search/**`, no `SearchInput`, no `useSearch`, no tests.
>   The plan's title and Goal line mentioning search are stale.
> - No version history or restore anywhere in the sharing/guest UI: those endpoints do not exist.
> - **Task 30's README must state both cuts honestly** under a "What is deliberately not built"
>   heading, with the one-line reason each (schedule; the `FileVersion` table and the `pg_trgm`
>   GIN index remain in the schema, so both are pure re-adds).
>
> **Stack reality:** React 19, Vite 8, TS 6 (`erasableSyntaxOnly`), Tailwind 4 (`@theme` tokens in
> src/index.css, no config file), react-router-dom v7 library mode, zustand, TanStack Query 5,
> vitest.config.ts separate from vite.config.ts.
>
> **Plan 04/05 debt this plan MUST clear:** `send()` in `src/api/client.ts` gives the share token
> precedence over the bearer, so a signed-in owner who opens a share link becomes a guest for every
> later request until it is cleared. Whatever sets the share token must clear it on leaving share
> routes — and that needs a test.
>
> **Deploy caveat for Task 30:** the PDF viewer fetches bytes and follows our 302 into the bucket,
> so the bucket CORS allow-list must include the deployed web origin, with GET. Dev MinIO allows it
> by default; Tigris does not until the origin is added.
>
> Batching: Task 26+27 = one dispatch; Task 29+30 = one dispatch. Task 28 skipped.

**Done when:** A reviewer can open the deployed URL, read the README's credentials, sign in as the owner, open a public guest link in a private window, see a scoped subtree with no way up, watch the owner revoke it and the guest get a clear message — and `pnpm test` plus CI are green.

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
- Mutation controls render only when `role === 'OWNER'`.
- Commit after every task. Conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`).

---

### Task 26: Share dialog with link and people tabs

**Files:**
- Create: `apps/web/src/shares/ShareDialog.tsx`, `hooks.ts`, `ShareList.tsx`
- Modify: `apps/web/src/browser/RoomPage.tsx` (wire `onShare`), `apps/web/src/browser/BrowserToolbar.tsx` (share the current folder)
- Test: `apps/web/src/shares/ShareDialog.test.tsx`

**Interfaces:**
- Consumes: `api`, `queryKeys`, `Dialog`, `Tabs`, `Button`, `Input`
- Produces:
  - `Share = { id: string; nodeId: string; mode: 'PUBLIC_LINK' | 'USER'; role: 'VIEWER'; granteeEmail: string | null; granteeId: string | null; createdAt: string; revokedAt: string | null }`
  - `useShares(nodeId)`, `useCreateShare(nodeId)`, `useRevokeShare(nodeId)`
  - `ShareDialog` — the created link is shown once, with copy-to-clipboard

- [ ] **Step 1: Write the failing test**

`apps/web/src/shares/ShareDialog.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShareDialog } from './ShareDialog'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const existingShares = [
  {
    id: 's1',
    nodeId: 'n1',
    mode: 'USER',
    role: 'VIEWER',
    granteeEmail: 'counsel@example.com',
    granteeId: null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  },
]

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return {
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <ShareDialog nodeId="n1" nodeName="Legal" nodeType="FOLDER" onClose={onClose} />
      </QueryClientProvider>,
    ),
  }
}

describe('ShareDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('creates a public link and shows it once with a copy button', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? json({ share: { ...existingShares[0], id: 's2', mode: 'PUBLIC_LINK', granteeEmail: null }, token: 'tok', url: 'https://app.test/s/tok' }, 201)
          : json([]),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: /Create link/i }))
    await waitFor(() => expect(screen.getByDisplayValue('https://app.test/s/tok')).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /Copy/i }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://app.test/s/tok')
    expect(screen.getByText(/shown once/i)).toBeTruthy()
  })

  it('invites a named user by email', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'POST' ? json({ share: existingShares[0] }, 201) : json([])),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderDialog()
    await userEvent.click(screen.getByRole('tab', { name: /People/i }))
    await userEvent.type(screen.getByLabelText(/Email/i), 'counsel@example.com')
    await userEvent.click(screen.getByRole('button', { name: /Invite/i }))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({ mode: 'USER', email: 'counsel@example.com' })
    })
  })

  it('lists current shares and revokes one', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'DELETE' ? json({ ...existingShares[0], revokedAt: new Date().toISOString() }) : json(existingShares)),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderDialog()
    await userEvent.click(screen.getByRole('tab', { name: /People/i }))
    await waitFor(() => expect(screen.getByText('counsel@example.com')).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: /Revoke access for counsel@example.com/i }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => (init as RequestInit)?.method === 'DELETE' && (url as string).includes('/shares/s1'))).toBe(true))
  })

  it('rejects an invalid email before sending', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([]))
    vi.stubGlobal('fetch', fetchMock)
    renderDialog()
    await userEvent.click(screen.getByRole('tab', { name: /People/i }))
    await userEvent.type(screen.getByLabelText(/Email/i), 'not-an-email')
    await userEvent.click(screen.getByRole('button', { name: /Invite/i }))
    expect(screen.getByRole('alert').textContent).toMatch(/valid email/i)
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit)?.method !== 'POST')).toBe(true)
  })

  it('states that access is read-only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([])))
    renderDialog()
    expect(screen.getByText(/read-only/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web test -- ShareDialog`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the hooks**

`apps/web/src/shares/hooks.ts`:
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { queryKeys } from '../api/keys'

export type Share = {
  id: string
  nodeId: string
  mode: 'PUBLIC_LINK' | 'USER'
  role: 'VIEWER'
  granteeEmail: string | null
  granteeId: string | null
  createdAt: string
  revokedAt: string | null
}

export type CreateShareResult = { share: Share; token?: string; url?: string }

export const useShares = (nodeId: string) =>
  useQuery({ queryKey: queryKeys.nodes.shares(nodeId), queryFn: () => api.get<Share[]>(`/nodes/${nodeId}/shares`) })

export function useCreateShare(nodeId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { mode: 'PUBLIC_LINK' } | { mode: 'USER'; email: string }) =>
      api.post<CreateShareResult>(`/nodes/${nodeId}/shares`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.nodes.shares(nodeId) }),
  })
}

export function useRevokeShare(nodeId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (shareId: string) => api.del<Share>(`/shares/${shareId}`),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.nodes.shares(nodeId) }),
  })
}
```

- [ ] **Step 4: Implement the dialog**

`apps/web/src/shares/ShareList.tsx`:
```tsx
import { Link2, Mail } from 'lucide-react'
import { Button } from '../components/ui/button'
import { formatRelativeDate } from '../lib/format'
import type { Share } from './hooks'

export function ShareList({
  shares,
  mode,
  onRevoke,
  revoking,
}: {
  shares: Share[]
  mode: Share['mode']
  onRevoke: (shareId: string) => void
  revoking: boolean
}) {
  const relevant = shares.filter((share) => share.mode === mode)
  const live = relevant.filter((share) => !share.revokedAt)

  if (!live.length) {
    return <p className="text-sm text-subtle">{mode === 'USER' ? 'Nobody has been invited yet.' : 'No active links.'}</p>
  }

  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {live.map((share) => (
        <li key={share.id} className="flex items-center gap-2 px-3 py-2">
          {mode === 'USER' ? <Mail size={14} className="text-subtle" /> : <Link2 size={14} className="text-subtle" />}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{share.granteeEmail ?? 'Anyone with the link'}</p>
            <p className="text-xs text-subtle">Viewer · added {formatRelativeDate(share.createdAt)}</p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={revoking}
            aria-label={`Revoke access for ${share.granteeEmail ?? 'the public link'}`}
            onClick={() => onRevoke(share.id)}
          >
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  )
}
```

`apps/web/src/shares/ShareDialog.tsx`:
```tsx
import { useState } from 'react'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '../api/client'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { ShareList } from './ShareList'
import { useCreateShare, useRevokeShare, useShares } from './hooks'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function ShareDialog({
  nodeId,
  nodeName,
  nodeType,
  isWholeRoom = false,
  onClose,
}: {
  nodeId: string
  nodeName: string
  nodeType: 'FOLDER' | 'FILE'
  isWholeRoom?: boolean
  onClose: () => void
}) {
  const shares = useShares(nodeId)
  const create = useCreateShare(nodeId)
  const revoke = useRevokeShare(nodeId)
  const [freshUrl, setFreshUrl] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)

  const subject = isWholeRoom ? 'this Data Room' : `${nodeType === 'FOLDER' ? 'folder' : 'file'} "${nodeName}"`

  async function createLink() {
    setError(null)
    try {
      const result = await create.mutateAsync({ mode: 'PUBLIC_LINK' })
      // The token is returned exactly once; keep it on screen until the dialog closes.
      setFreshUrl(result.url ?? null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the link')
    }
  }

  async function invite() {
    if (!EMAIL.test(email.trim())) {
      setError('Enter a valid email address')
      return
    }
    setError(null)
    try {
      await create.mutateAsync({ mode: 'USER', email: email.trim().toLowerCase() })
      setEmail('')
      toast.success('Invitation added')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not invite that address')
    }
  }

  return (
    <Dialog open onOpenChange={onClose} title={`Share ${subject}`} description="Recipients get read-only access to this item and everything inside it.">
      <Tabs defaultValue="link">
        <TabsList>
          <TabsTrigger value="link">Link</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
        </TabsList>

        <TabsContent value="link" className="flex flex-col gap-3">
          {freshUrl ? (
            <div className="flex flex-col gap-1">
              <div className="flex gap-2">
                <Input readOnly value={freshUrl} onFocus={(e) => e.currentTarget.select()} />
                <Button
                  onClick={async () => {
                    await navigator.clipboard.writeText(freshUrl)
                    toast.success('Link copied')
                  }}
                >
                  <Copy size={14} /> Copy
                </Button>
              </div>
              <p className="text-xs text-subtle">This link is shown once. If you lose it, create a new one and revoke this.</p>
            </div>
          ) : (
            <Button variant="primary" disabled={create.isPending} onClick={() => void createLink()}>
              {create.isPending ? 'Creating…' : 'Create link'}
            </Button>
          )}

          {shares.data ? (
            <ShareList shares={shares.data} mode="PUBLIC_LINK" revoking={revoke.isPending} onRevoke={(id) => void revoke.mutateAsync(id)} />
          ) : null}
        </TabsContent>

        <TabsContent value="people" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="share-email">
              Email
            </label>
            <div className="flex gap-2">
              <Input id="share-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="counsel@example.com" />
              <Button variant="primary" disabled={create.isPending} onClick={() => void invite()}>
                Invite
              </Button>
            </div>
            <p className="text-xs text-subtle">They do not need an account yet — access starts when they register with this address.</p>
          </div>

          {shares.data ? (
            <ShareList shares={shares.data} mode="USER" revoking={revoke.isPending} onRevoke={(id) => void revoke.mutateAsync(id)} />
          ) : null}
        </TabsContent>
      </Tabs>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Dialog>
  )
}
```

- [ ] **Step 5: Wire it in**

In `apps/web/src/browser/RoomPage.tsx`, add `const [sharing, setSharing] = useState<NodeItem | null>(null)`, pass `onShare={setSharing}` to `NodeTable`, add a "Share" button to the toolbar for the current folder, and render:
```tsx
  {sharing ? (
    <ShareDialog nodeId={sharing.id} nodeName={sharing.name} nodeType={sharing.type} onClose={() => setSharing(null)} />
  ) : null}
  {sharingCurrentFolder && first ? (
    <ShareDialog
      nodeId={first.parent.id}
      nodeName={first.parent.name}
      nodeType="FOLDER"
      isWholeRoom={first.parent.id === first.scopeRootId && !nodeId}
      onClose={() => setSharingCurrentFolder(false)}
    />
  ) : null}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter web test -- ShareDialog`
Expected: five PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/shares apps/web/src/browser
git commit -m "feat(web): share dialog with public links, email invitations and revocation"
```

---

### Task 27: The guest experience

**Files:**
- Create: `apps/web/src/guest/GuestPage.tsx`, `GuestGoneState.tsx`
- Modify: `apps/web/src/routes.tsx`, `apps/web/src/components/AppShell.tsx` (guest header), `apps/web/src/files/FileViewerPage.tsx`
- Modify: `apps/api/src/access/access.guard.ts` (accept the token as a query parameter), `apps/api/src/files/files.controller.ts`
- Test: `apps/web/src/guest/GuestPage.test.tsx`, `apps/api/test/share-token-query.e2e-spec.ts`

**Interfaces:**
- Consumes: `setShareToken`, `queryKeys`, `FileBrowser`, `NodeTable`, `AccessProvider`
- Produces:
  - Route `/s/:token` — resolves the token, then renders the shared folder or file
  - `AccessGuard` accepts `?shareToken=` in addition to `X-Share-Token`
  - `GuestGoneState` — the 410 screen

**Why the API changes here:** an `iframe` cannot carry a custom header, so a guest could never render a PDF inline. Accepting the token as a query parameter on read routes closes that gap. The token is already a URL-borne secret — it arrives in the address bar — so this adds no new exposure.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/share-token-query.e2e-spec.ts`:
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

describe('share token as a query parameter', () => {
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

  it('accepts the token in the query string on the content route', async () => {
    const owner = await createUser()
    const { roomId, rootId, root } = await createRoom(owner.id)
    const file = await createFile({ ...root, roomId }, 'MSA.pdf', owner.id)
    const token = 'query-token-fixture'
    await createShare({ nodeId: rootId, mode: 'PUBLIC_LINK', createdById: owner.id, tokenHash: hashShareToken(token) })

    await request(app.getHttpServer()).get(`/nodes/${file.id}/content?shareToken=${token}`).expect(302)
  })

  it('still rejects a bad token in the query string', async () => {
    const owner = await createUser()
    const { roomId, root } = await createRoom(owner.id)
    const file = await createFile({ ...root, roomId }, 'MSA.pdf', owner.id)
    await request(app.getHttpServer()).get(`/nodes/${file.id}/content?shareToken=nope`).expect(404)
  })
})
```

`apps/web/src/guest/GuestPage.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GuestPage } from './GuestPage'
import { setShareToken } from '../api/client'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const bootstrap = {
  role: 'VIEWER',
  roomId: 'r1',
  roomName: 'Project Titan',
  node: { id: 'legal', name: 'Legal', type: 'FOLDER' },
}

const listing = {
  items: [{ id: 'd1', type: 'FILE', name: 'MSA.pdf', sizeBytes: 2048, updatedAt: new Date().toISOString(), currentVersionId: 'v1' }],
  nextCursor: null,
  breadcrumbs: [{ id: 'legal', name: 'Legal', type: 'FOLDER' }],
  parent: { id: 'legal', name: 'Legal', parentId: null },
  role: 'VIEWER',
  scopeRootId: 'legal',
}

function renderGuest() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/s/tok']}>
        <Routes>
          <Route path="/s/:token" element={<GuestPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('GuestPage', () => {
  beforeEach(() => {
    setShareToken(null)
    vi.restoreAllMocks()
  })

  it('resolves the token, then lists the shared folder read-only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => Promise.resolve(json(url.includes('/shared/') ? bootstrap : listing))),
    )
    renderGuest()
    await waitFor(() => expect(screen.getByText('MSA.pdf')).toBeTruthy())
    expect(screen.getByText(/Shared with you/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /New folder/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Upload/i })).toBeNull()
  })

  it('shows the revoked message on 410 rather than a bare not-found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ code: 'GONE', message: 'This link is no longer active' }, 410)))
    renderGuest()
    await waitFor(() => expect(screen.getByText(/no longer active/i)).toBeTruthy())
  })

  it('shows a not-found message for a token that never existed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ code: 'NOT_FOUND', message: 'Not found' }, 404)))
    renderGuest()
    await waitFor(() => expect(screen.getByText(/link is not valid/i)).toBeTruthy())
  })

  it('shows the owner-deleted message when the item disappears mid-session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('/shared/') ? json(bootstrap) : json({ code: 'GONE', message: 'This item was deleted by the owner' }, 410),
        ),
      ),
    )
    renderGuest()
    await waitFor(() => expect(screen.getByText(/deleted by the owner/i)).toBeTruthy())
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter api test:e2e -- share-token-query` and `pnpm --filter web test -- GuestPage`
Expected: both FAIL.

- [ ] **Step 3: Accept the token from the query string**

In `apps/api/src/access/access.guard.ts`, replace the token extraction line:
```ts
    // An iframe cannot send a custom header, so read routes also accept ?shareToken=.
    // The token already travels in the URL of the share link itself, so this exposes nothing new.
    const shareToken =
      (req.headers['x-share-token'] as string | undefined) ?? (req.query.shareToken as string | undefined) ?? undefined
```

Add `shareToken` to the allowed query parameters of the content route so `forbidNonWhitelisted` does not reject it — in `apps/api/src/files/files.controller.ts`:
```ts
import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString } from 'class-validator'

export class ContentQueryDto {
  @ApiPropertyOptional({ description: 'Specific version id; defaults to current' })
  @IsOptional()
  @IsString()
  version?: string

  @ApiPropertyOptional({ description: 'Share token, for contexts that cannot send a header (iframe, direct link)' })
  @IsOptional()
  @IsString()
  shareToken?: string
}
```
and change the handler signature to `@Query() query: ContentQueryDto`, passing `query.version`.

- [ ] **Step 4: Implement the guest screens**

`apps/web/src/guest/GuestGoneState.tsx`:
```tsx
import { ApiError } from '../api/client'

/** The spec's wording, in one place: 410 is "it went away", 404 is "it never was". */
export function GuestGoneState({ error }: { error: unknown }) {
  const isApi = error instanceof ApiError
  const title = isApi && error.status === 410 ? error.message : 'This link is not valid'
  const hint =
    isApi && error.status === 410
      ? 'Ask the person who shared it to send a new link.'
      : 'Check that you copied the whole link, or ask for a new one.'

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="max-w-sm text-sm text-subtle">{hint}</p>
    </main>
  )
}
```

`apps/web/src/guest/GuestPage.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, setShareToken } from '../api/client'
import { queryKeys } from '../api/keys'
import { AccessProvider } from '../access/AccessProvider'
import { ErrorState } from '../components/ErrorState'
import { TableSkeleton } from '../components/Skeleton'
import { FileBrowser } from '../browser/FileBrowser'
import { NodeTable } from '../browser/NodeTable'
import { useNodeList, type SortMode } from '../browser/hooks/useNodeList'
import { GuestGoneState } from './GuestGoneState'

type Bootstrap = {
  role: 'VIEWER'
  roomId: string
  roomName: string
  node: { id: string; name: string; type: 'FOLDER' | 'FILE' }
}

/**
 * The token is stored in the API client, then the ordinary browser components take over.
 * Nothing below this component knows it is serving a guest — the role in the listing
 * response is what hides every mutation control.
 */
export function GuestPage() {
  const { token = '' } = useParams()
  const [folderId, setFolderId] = useState<string | null>(null)
  const [openFile, setOpenFile] = useState<{ id: string; name: string } | null>(null)
  const [sort, setSort] = useState<SortMode>('name')

  useEffect(() => {
    setShareToken(token)
    return () => setShareToken(null)
  }, [token])

  const bootstrap = useQuery({
    queryKey: queryKeys.sharedBootstrap(token),
    queryFn: () => api.get<Bootstrap>(`/shared/${token}`),
  })

  const targetId = folderId ?? bootstrap.data?.node.id ?? null
  // Either the share itself is a file, or the guest clicked one inside a shared folder.
  const viewing = openFile ?? (bootstrap.data?.node.type === 'FILE' ? bootstrap.data.node : null)
  const list = useNodeList(bootstrap.data?.roomId ?? '', targetId, sort)

  if (bootstrap.isPending) return <TableSkeleton rows={4} />
  if (bootstrap.isError) return <GuestGoneState error={bootstrap.error} />
  if (list.isError) return <GuestGoneState error={list.error} />

  const first = list.data?.pages[0]
  const items = list.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <AccessProvider role="VIEWER" scopeRootId={bootstrap.data.node.id}>
      <div className="min-h-screen">
        <header className="flex h-14 items-center gap-3 border-b border-border bg-surface px-4">
          <span className="text-sm font-semibold">Data Room</span>
          <span className="rounded bg-muted px-2 py-0.5 text-xs text-subtle">Shared with you · read-only</span>
        </header>

        <main className="mx-auto w-full max-w-6xl px-4 py-6">
          {viewing ? (
            <section className="overflow-hidden rounded-lg border border-border bg-surface">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <h1 className="flex-1 truncate text-sm font-semibold">{viewing.name}</h1>
                {openFile ? (
                  <button type="button" className="text-sm text-accent hover:underline" onClick={() => setOpenFile(null)}>
                    Back to folder
                  </button>
                ) : null}
              </div>
              <iframe
                title={viewing.name}
                src={`/api/nodes/${viewing.id}/content?shareToken=${encodeURIComponent(token)}`}
                className="h-[75vh] w-full"
              />
            </section>
          ) : (
            <FileBrowser
              roomId={bootstrap.data.roomId}
              crumbs={first?.breadcrumbs ?? []}
              onDropOnCrumb={() => undefined}
              toolbar={
                <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                  <label className="sr-only" htmlFor="guest-sort">
                    Sort by
                  </label>
                  <select
                    id="guest-sort"
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortMode)}
                    className="h-8 rounded-md border border-border bg-surface px-2 text-sm"
                  >
                    <option value="name">Name</option>
                    <option value="updatedAt">Last modified</option>
                    <option value="size">Size</option>
                  </select>
                </div>
              }
            >
              <NodeTable
                roomId={bootstrap.data.roomId}
                items={items}
                isLoading={list.isPending}
                hasMore={Boolean(list.hasNextPage)}
                onLoadMore={() => void list.fetchNextPage()}
                onRename={() => undefined}
                onMove={() => undefined}
                onDelete={() => undefined}
                onShare={() => undefined}
                onDropOnFolder={() => undefined}
                onNavigateFolder={setFolderId}
                onOpenFile={setOpenFile}
              />
            </FileBrowser>
          )}
        </main>
      </div>
    </AccessProvider>
  )
}
```

Guest navigation needs one change in `NodeRow`: its folder link points at `/rooms/:roomId/f/:nodeId`, which sits behind `RequireAuth`, so a guest clicking a folder would be bounced to `/login`. Add an optional navigation callback — when present, folders render as a button and the guest never leaves `/s/:token`, which also means there is no URL for them to edit into the rest of the room.

In `apps/web/src/browser/NodeRow.tsx`, extend the actions type and the name cell:
```tsx
export type NodeRowActions = {
  onRename: (node: NodeItem) => void
  onMove: (node: NodeItem) => void
  onDelete: (node: NodeItem) => void
  onShare: (node: NodeItem) => void
  onDropOnFolder: (sourceId: string, targetFolderId: string) => void
  /** Supplied by the guest view: navigate in place instead of routing. */
  onNavigateFolder?: (nodeId: string) => void
  /** Supplied by the guest view: open a file without an authenticated route. */
  onOpenFile?: (node: NodeItem) => void
}
```
```tsx
      {node.type === 'FOLDER' && actions.onNavigateFolder ? (
        <button type="button" className="min-w-0 flex-1 truncate text-left text-sm hover:text-accent" onClick={() => actions.onNavigateFolder!(node.id)}>
          {node.name}
        </button>
      ) : node.type === 'FILE' && actions.onOpenFile ? (
        <button type="button" className="min-w-0 flex-1 truncate text-left text-sm hover:text-accent" onClick={() => actions.onOpenFile!(node)}>
          {node.name}
        </button>
      ) : (
        <Link to={href} className="min-w-0 flex-1 truncate text-sm hover:text-accent">
          {node.name}
        </Link>
      )}
```
`NodeTable` already spreads its extra props into `actions`, so both callbacks pass through untouched. `GuestPage` supplies `onNavigateFolder={setFolderId}` and `onOpenFile={setOpenFile}`, where `openFile` state renders the same iframe used for a file-level share. Owner screens pass neither, so their rows stay ordinary links — no behaviour changes for them.

The existing test "hides every mutation action from a viewer" still passes: the row menu's `Open` item is unaffected, and the guest branch only changes the name cell.

Add the route in `apps/web/src/routes.tsx`, outside `RequireAuth`:
```tsx
      <Route path="/s/:token" element={<GuestPage />} />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter api test:e2e -- share-token-query` then `pnpm --filter web test -- GuestPage`
Expected: all PASS. The two guest states that carry the spec's judgement: a revoked link says so, an invented one does not.

- [ ] **Step 6: Verify the whole share loop by hand**

Run `pnpm dev`. As the owner, share a subfolder by link. Open the link in a private window. Then, as the owner, delete that folder.
Expected: the guest sees only the shared subtree with no breadcrumb above it and no mutation controls; after the delete, the next guest action reports "deleted by the owner"; after a revoke instead, it reports "no longer active".

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/guest apps/web/src/browser apps/web/src/routes.tsx apps/api/src/access apps/api/src/files apps/api/test
git commit -m "feat: guest share experience with scoped browsing and clear revoked/deleted states"
```

---

### Task 28: Search across a Data Room

**Files:**
- Create: `apps/web/src/search/SearchInput.tsx`, `SearchResults.tsx`, `hooks.ts`
- Modify: `apps/web/src/browser/RoomPage.tsx`
- Test: `apps/web/src/search/SearchResults.test.tsx`

**Interfaces:**
- Consumes: `api`, `queryKeys`
- Produces:
  - `SearchHit = { id: string; name: string; type: 'FOLDER' | 'FILE'; sizeBytes: number | null; updatedAt: string; parentId: string | null; parentName: string | null }`
  - `useSearch(roomId, q, scopeParentId)` — debounced, disabled under two characters
  - `SearchInput` with a clear button; `SearchResults` replacing the table while a query is active

- [ ] **Step 1: Write the failing test**

`apps/web/src/search/SearchResults.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchResults } from './SearchResults'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const hits = {
  items: [
    {
      id: 'd1',
      name: 'FY23 Audit.pdf',
      type: 'FILE',
      sizeBytes: 2048,
      updatedAt: new Date().toISOString(),
      parentId: 'fin',
      parentName: 'Financials',
    },
  ],
  nextCursor: null,
}

function renderResults(term: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SearchResults roomId="r1" term={term} scopeParentId={null} onClear={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SearchResults', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows each hit with the folder that contains it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(hits)))
    renderResults('audit')
    await waitFor(() => expect(screen.getByText('FY23 Audit.pdf')).toBeTruthy())
    expect(screen.getByText(/in Financials/i)).toBeTruthy()
  })

  it('shows a specific empty state naming the term', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ items: [], nextCursor: null })))
    renderResults('zzz')
    await waitFor(() => expect(screen.getByText(/No files match "zzz"/i)).toBeTruthy())
  })

  it('does not query for a single character', () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ items: [], nextCursor: null }))
    vi.stubGlobal('fetch', fetchMock)
    renderResults('a')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces an error state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ code: 'UNKNOWN', message: 'boom' }, 500)))
    renderResults('audit')
    await waitFor(() => expect(screen.getByText(/Something went wrong/i)).toBeTruthy())
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web test -- SearchResults`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the hook and components**

`apps/web/src/search/hooks.ts`:
```ts
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { queryKeys } from '../api/keys'

export type SearchHit = {
  id: string
  name: string
  type: 'FOLDER' | 'FILE'
  sizeBytes: number | null
  updatedAt: string
  parentId: string | null
  parentName: string | null
}

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export function useSearch(roomId: string, term: string, scopeParentId: string | null) {
  const trimmed = term.trim()
  return useQuery({
    queryKey: queryKeys.search(roomId, `${trimmed}|${scopeParentId ?? 'room'}`),
    // Two characters is the server's minimum too; querying on one would only earn a 400.
    enabled: trimmed.length >= 2,
    queryFn: () => {
      const params = new URLSearchParams({ q: trimmed, limit: '50' })
      if (scopeParentId) params.set('parentId', scopeParentId)
      return api.get<{ items: SearchHit[]; nextCursor: string | null }>(`/rooms/${roomId}/search?${params.toString()}`)
    },
  })
}
```

`apps/web/src/search/SearchInput.tsx`:
```tsx
import { Search, X } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'

export function SearchInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Search size={14} className="shrink-0 text-subtle" />
      <label className="sr-only" htmlFor="search">
        Search this Data Room
      </label>
      <Input
        id="search"
        value={value}
        placeholder="Search by name…"
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-48 sm:w-64"
      />
      {value ? (
        <Button size="icon" variant="ghost" aria-label="Clear search" onClick={() => onChange('')}>
          <X size={14} />
        </Button>
      ) : null}
    </div>
  )
}
```

`apps/web/src/search/SearchResults.tsx`:
```tsx
import { FileText, Folder } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { TableSkeleton } from '../components/Skeleton'
import { Button } from '../components/ui/button'
import { formatBytes, formatRelativeDate } from '../lib/format'
import { useSearch } from './hooks'

export function SearchResults({
  roomId,
  term,
  scopeParentId,
  onClear,
}: {
  roomId: string
  term: string
  scopeParentId: string | null
  onClear: () => void
}) {
  const search = useSearch(roomId, term, scopeParentId)

  if (term.trim().length < 2) return <EmptyState title="Keep typing" hint="Enter at least two characters to search." />
  if (search.isPending) return <TableSkeleton rows={4} />
  if (search.isError) return <ErrorState error={search.error} onRetry={() => void search.refetch()} />
  if (!search.data.items.length) {
    return <EmptyState title={`No files match "${term.trim()}"`} action={<Button onClick={onClear}>Clear search</Button>} />
  }

  return (
    <div className="divide-y divide-border">
      {search.data.items.map((hit) => (
        <div key={hit.id} className="flex items-center gap-3 px-4 py-2.5">
          {hit.type === 'FOLDER' ? (
            <Folder size={16} className="shrink-0 text-accent" />
          ) : (
            <FileText size={16} className="shrink-0 text-subtle" />
          )}
          <div className="min-w-0 flex-1">
            <Link
              to={hit.type === 'FOLDER' ? `/rooms/${roomId}/f/${hit.id}` : `/rooms/${roomId}/file/${hit.id}`}
              className="block truncate text-sm hover:text-accent"
            >
              {hit.name}
            </Link>
            {/* Context matters in search results: the same filename appears in many folders. */}
            <p className="truncate text-xs text-subtle">{hit.parentName ? `in ${hit.parentName}` : 'in this Data Room'}</p>
          </div>
          <span className="w-20 shrink-0 text-right text-xs text-subtle">
            {hit.type === 'FILE' && hit.sizeBytes !== null ? formatBytes(hit.sizeBytes) : '—'}
          </span>
          <span className="hidden w-28 shrink-0 text-right text-xs text-subtle sm:inline">{formatRelativeDate(hit.updatedAt)}</span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Wire search into RoomPage**

In `apps/web/src/browser/RoomPage.tsx`:
```tsx
  const [term, setTerm] = useState('')
  const debouncedTerm = useDebounced(term)
  const searching = debouncedTerm.trim().length >= 2
```
Pass `<SearchInput value={term} onChange={setTerm} />` as the toolbar's `children`, and render `searching ? <SearchResults roomId={roomId} term={debouncedTerm} scopeParentId={first?.role === 'VIEWER' ? first.scopeRootId : null} onClear={() => setTerm('')} /> : <NodeTable … />`.

The `scopeParentId` is what keeps a guest's search inside their share: for an owner it is `null`, so the API resolves access from the room and searches the whole tree.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter web test -- SearchResults`
Expected: four PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/search apps/web/src/browser/RoomPage.tsx
git commit -m "feat(web): debounced name search with folder context and scoped guest results"
```

---

### Task 29: Seed data a reviewer can open immediately

**Files:**
- Create: `apps/api/src/seed/seed.ts`, `apps/api/src/seed/make-pdf.ts`
- Modify: `apps/api/prisma.config.ts` — add `migrations.seed: 'ts-node src/seed/seed.ts'`. Task 4 deliberately left it out: a seed entry pointing at a missing script hangs `prisma migrate dev` on a prompt with no TTY. Now the script exists, so wiring it is safe and `prisma db seed` works.
- Test: `apps/api/test/seed.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (via a standalone Nest context), `StorageService`, `blobKeyFor`, `generateShareToken`
- Produces:
  - `pnpm seed` — idempotent: it deletes and recreates the demo accounts and their rooms
  - Prints the demo credentials and the guest link on stdout, for pasting into the README

- [ ] **Step 1: Write the failing test**

`apps/api/test/seed.e2e-spec.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client'

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) })

describe('seed', () => {
  afterAll(() => prisma.$disconnect())

  it('creates the demo owner, a scoped counsel grant, versions and a public link', () => {
    const output = execFileSync('pnpm', ['--filter', 'api', 'seed'], { encoding: 'utf8' })
    expect(output).toMatch(/demo@dataroom\.app/)
    expect(output).toMatch(/counsel@example\.com/)
    expect(output).toMatch(/\/s\/[A-Za-z0-9_-]{43}/)
  }, 120_000)

  it('is idempotent — running it twice leaves one demo owner', () => {
    execFileSync('pnpm', ['--filter', 'api', 'seed'], { encoding: 'utf8' })
    return expect(prisma.user.count({ where: { email: 'demo@dataroom.app' } })).resolves.toBe(1)
  }, 120_000)

  it('gives counsel a grant on Legal only', async () => {
    const share = await prisma.share.findFirstOrThrow({
      where: { granteeEmail: 'counsel@example.com', revokedAt: null },
      include: { node: true },
    })
    expect(share.node.name).toContain('Legal')
    expect(share.mode).toBe('USER')
  })

  it('leaves one file with three versions so history is not empty', async () => {
    const grouped = await prisma.fileVersion.groupBy({ by: ['nodeId'], _count: { id: true } })
    expect(grouped.some((row) => row._count.id >= 3)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter api test:e2e -- seed`
Expected: FAIL — the seed script does not exist.

- [ ] **Step 3: Implement the PDF generator**

`apps/api/src/seed/make-pdf.ts`:
```ts
import { PDFDocument, StandardFonts } from 'pdf-lib'

/** Real PDFs, not placeholder bytes — the viewer has to render these. */
export async function makePdf(title: string, lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const page = doc.addPage([595, 842])

  page.drawText(title, { x: 56, y: 760, size: 20, font: bold })
  page.drawText('Project Titan — confidential due diligence material', { x: 56, y: 736, size: 10, font })

  lines.forEach((line, index) => {
    page.drawText(line, { x: 56, y: 690 - index * 18, size: 11, font })
  })

  return Buffer.from(await doc.save())
}
```

- [ ] **Step 4: Implement the seed**

`apps/api/src/seed/seed.ts`:
```ts
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import * as argon2 from 'argon2'
import { randomUUID } from 'node:crypto'
import { AppModule } from '../app.module'
import { PrismaService } from '../prisma/prisma.service'
import { StorageService, blobKeyFor } from '../storage/storage.service'
import { generateShareToken } from '../access/share-token'
import { childPath, ROOT_PATH } from '../nodes/node-path'
import { makePdf } from './make-pdf'

const OWNER_EMAIL = 'demo@dataroom.app'
const COUNSEL_EMAIL = 'counsel@example.com'
const PASSWORD = 'demo1234'

const TREE: Record<string, string[]> = {
  '01 Corporate': ['Certificate of Incorporation.pdf', 'Bylaws.pdf', 'Cap Table.pdf', 'Board Consents 2025.pdf'],
  '02 Financials': ['FY23 Audited Statements.pdf', 'FY24 Audited Statements.pdf', 'Management Accounts Q1.pdf'],
  '03 Legal': ['Master Services Agreement.pdf', 'Litigation Summary.pdf'],
  '04 IP': ['Patent Portfolio.pdf', 'Trademark Register.pdf', 'Open Source Inventory.pdf'],
  '05 Commercial': ['Top 20 Customers.pdf', 'Churn Analysis.pdf', 'Pricing Policy.pdf'],
  '06 People': ['Org Chart.pdf', 'Employment Agreements Summary.pdf', 'Option Grants.pdf'],
}

const NESTED: Record<string, Record<string, string[]>> = {
  '02 Financials': { FY23: ['FY23 Trial Balance.pdf', 'FY23 Revenue by Segment.pdf'] },
  '03 Legal': { Contracts: ['Reseller Agreement — EMEA.pdf', 'NDA — Acquirer.pdf', 'Supplier Framework.pdf'] },
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] })
  const prisma = app.get(PrismaService)
  const storage = app.get(StorageService)

  // Idempotent by construction: drop the demo accounts, and rooms cascade with them.
  await prisma.user.deleteMany({ where: { email: { in: [OWNER_EMAIL, COUNSEL_EMAIL] } } })

  const passwordHash = await argon2.hash(PASSWORD)
  const owner = await prisma.user.create({ data: { email: OWNER_EMAIL, name: 'Dana Owner', passwordHash } })
  const counsel = await prisma.user.create({ data: { email: COUNSEL_EMAIL, name: 'Sam Counsel', passwordHash } })

  const roomId = randomUUID()
  const rootId = randomUUID()
  const roomName = 'Project Titan — Acme Acquisition'
  await prisma.dataRoom.create({ data: { id: roomId, ownerId: owner.id, name: roomName, rootNodeId: rootId } })
  await prisma.node.create({
    data: { id: rootId, roomId, parentId: null, type: 'FOLDER', name: roomName, path: ROOT_PATH, status: 'ACTIVE', createdById: owner.id },
  })
  const root = { id: rootId, path: ROOT_PATH }

  async function addFile(parent: { id: string; path: string }, name: string, versionNo = 1) {
    const nodeId = randomUUID()
    const pdf = await makePdf(name.replace(/\.pdf$/, ''), [
      'This document is generated seed data for the Data Room demo.',
      `File: ${name}`,
      `Version: ${versionNo}`,
      '',
      'Prepared for evaluation purposes only.',
    ])
    const blobKey = blobKeyFor(roomId, nodeId, versionNo)
    const { url } = await storage.presignPut(blobKey, 'application/pdf')
    const put = await fetch(url, { method: 'PUT', body: pdf, headers: { 'Content-Type': 'application/pdf' } })
    if (!put.ok) throw new Error(`Seed upload failed for ${name}: ${put.status}`)

    const node = await prisma.node.create({
      data: {
        id: nodeId,
        roomId,
        parentId: parent.id,
        type: 'FILE',
        name,
        path: childPath(parent),
        status: 'ACTIVE',
        sizeBytes: BigInt(pdf.byteLength),
        createdById: owner.id,
      },
    })
    const version = await prisma.fileVersion.create({
      data: { nodeId, versionNo, blobKey, sizeBytes: BigInt(pdf.byteLength), mimeType: 'application/pdf', createdById: owner.id },
    })
    await prisma.node.update({ where: { id: nodeId }, data: { currentVersionId: version.id } })
    return node
  }

  async function addFolder(parent: { id: string; path: string }, name: string) {
    return prisma.node.create({
      data: { roomId, parentId: parent.id, type: 'FOLDER', name, path: childPath(parent), status: 'ACTIVE', createdById: owner.id },
    })
  }

  const folders: Record<string, { id: string; path: string }> = {}
  for (const [folderName, files] of Object.entries(TREE)) {
    const folder = await addFolder(root, folderName)
    folders[folderName] = folder
    for (const file of files) await addFile(folder, file)
  }

  for (const [parentName, children] of Object.entries(NESTED)) {
    for (const [childName, files] of Object.entries(children)) {
      const child = await addFolder(folders[parentName], childName)
      for (const file of files) await addFile(child, file)
      if (parentName === '02 Financials') folders['FY23'] = child
    }
  }

  // One file with three versions, so version history is not an empty drawer.
  const versioned = await addFile(folders['02 Financials'], 'Working Capital Model.pdf', 1)
  for (const versionNo of [2, 3]) {
    const pdf = await makePdf('Working Capital Model', [`Revision ${versionNo}`, 'Superseded figures updated.'])
    const blobKey = blobKeyFor(roomId, versioned.id, versionNo)
    const { url } = await storage.presignPut(blobKey, 'application/pdf')
    await fetch(url, { method: 'PUT', body: pdf, headers: { 'Content-Type': 'application/pdf' } })
    const version = await prisma.fileVersion.create({
      data: {
        nodeId: versioned.id,
        versionNo,
        blobKey,
        sizeBytes: BigInt(pdf.byteLength),
        mimeType: 'application/pdf',
        createdById: owner.id,
      },
    })
    await prisma.node.update({ where: { id: versioned.id }, data: { currentVersionId: version.id, sizeBytes: BigInt(pdf.byteLength) } })
  }

  // A scoped grant, so a reviewer can watch the tree truncate for a real account.
  await prisma.share.create({
    data: { nodeId: folders['03 Legal'].id, mode: 'USER', role: 'VIEWER', granteeEmail: COUNSEL_EMAIL, granteeId: counsel.id, createdById: owner.id },
  })

  const { token, tokenHash } = generateShareToken()
  await prisma.share.create({
    data: { nodeId: folders['FY23'].id, mode: 'PUBLIC_LINK', role: 'VIEWER', tokenHash, createdById: owner.id },
  })

  const appUrl = process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'
  process.stdout.write(
    [
      '',
      'Seed complete.',
      `  Owner:   ${OWNER_EMAIL} / ${PASSWORD}`,
      `  Counsel: ${COUNSEL_EMAIL} / ${PASSWORD}   (granted "03 Legal" only)`,
      `  Guest link: ${appUrl}/s/${token}          (public, "02 Financials/FY23")`,
      '',
    ].join('\n'),
  )

  await app.close()
}

void main()
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
docker compose up -d
pnpm --filter api test:e2e -- seed
```
Expected: four PASS, and the credentials plus guest link printed.

- [ ] **Step 6: Seed the deployed environment**

Run: `railway run pnpm --filter api seed` (or the platform equivalent), then sign in on the deployed URL as `demo@dataroom.app`.
Expected: the full tree, real PDFs rendering, and the printed guest link working in a private window.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/seed apps/api/test/seed.e2e-spec.ts
git commit -m "feat(api): seed demo data with real generated pdfs, a scoped grant and a public link"
```

---

### Task 30: CI, README, and release verification

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `README.md` (replacing the Plan 01 placeholder)
- Create: `docs/erd.md`
- Test: the workflow itself, plus a manual release checklist

**Interfaces:**
- Consumes: everything
- Produces: green CI on push, a README that answers the three scaling questions, verified live URLs

- [ ] **Step 1: Write the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  api:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: dataroom
          POSTGRES_PASSWORD: dataroom
          POSTGRES_DB: dataroom
        ports: ['5433:5432']
        options: >-
          --health-cmd "pg_isready -U dataroom" --health-interval 5s --health-timeout 5s --health-retries 10
      minio:
        image: bitnami/minio:latest
        env:
          MINIO_ROOT_USER: minioadmin
          MINIO_ROOT_PASSWORD: minioadmin
          MINIO_DEFAULT_BUCKETS: data-room
        ports: ['9000:9000']
        options: >-
          --health-cmd "curl -f http://localhost:9000/minio/health/live" --health-interval 5s --health-retries 20
    env:
      DATABASE_URL: postgresql://dataroom:dataroom@localhost:5433/dataroom?schema=public
      JWT_SECRET: ci-jwt-secret-value-long-enough
      REFRESH_SECRET: ci-refresh-secret-value-long-enough
      PUBLIC_APP_URL: http://localhost:5173
      S3_ENDPOINT: http://localhost:9000
      S3_BUCKET: data-room
      S3_REGION: us-east-1
      S3_ACCESS_KEY_ID: minioadmin
      S3_SECRET_ACCESS_KEY: minioadmin
      S3_FORCE_PATH_STYLE: 'true'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter api prisma generate
      - run: pnpm --filter api prisma migrate deploy
      - run: pnpm --filter api lint
      - run: pnpm --filter api test
      - run: pnpm --filter api test:e2e
      - run: pnpm --filter api openapi:emit
      - uses: actions/upload-artifact@v4
        with:
          name: openapi
          path: apps/api/openapi.json

  web:
    runs-on: ubuntu-latest
    needs: api
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - uses: actions/download-artifact@v4
        with: { name: openapi, path: apps/api }
      - run: pnpm install --frozen-lockfile
      # Regenerating here proves the committed types still match the API contract.
      - run: pnpm --filter web openapi:types
      - run: git diff --exit-code apps/web/src/api/schema.d.ts
      - run: pnpm --filter web lint
      - run: pnpm --filter web test
      - run: pnpm --filter web build
```

The `git diff --exit-code` step is the point of emitting the contract in CI: a DTO change that the frontend has not regenerated types for fails the build rather than production.

- [ ] **Step 2: Write the ERD**

`docs/erd.md`:
```markdown
# Data model

```mermaid
erDiagram
    User ||--o{ DataRoom : owns
    DataRoom ||--|| Node : "root node"
    DataRoom ||--o{ Node : contains
    Node ||--o{ Node : "parent of"
    Node ||--o{ FileVersion : "has versions"
    Node ||--o| FileVersion : "current version"
    Node ||--o{ Share : "granted through"
    User ||--o{ Share : "granted to (by email)"

    User {
        uuid id PK
        string email UK "lower-cased"
        string passwordHash "null for Google-only"
        string googleId UK
        string name
    }
    DataRoom {
        uuid id PK
        uuid ownerId FK
        string name
        uuid rootNodeId UK
    }
    Node {
        uuid id PK
        uuid roomId FK
        uuid parentId FK "null only on a root node"
        enum type "FOLDER | FILE"
        string name
        string path "materialized: /rootId/folderId/"
        enum status "PENDING | ACTIVE"
        uuid currentVersionId FK
        bigint sizeBytes "denormalized for rollups"
        datetime deletedAt "tombstone"
    }
    FileVersion {
        uuid id PK
        uuid nodeId FK
        int versionNo
        string blobKey "rooms/{roomId}/nodes/{nodeId}/v{n}"
        bigint sizeBytes
        string mimeType
    }
    Share {
        uuid id PK
        uuid nodeId FK "a Data Room is shared via its root node"
        enum mode "PUBLIC_LINK | USER"
        enum role "VIEWER (EDITOR is a one-line addition)"
        string tokenHash UK "sha256 of the token; the token is never stored"
        string granteeEmail "invite works before registration"
        datetime revokedAt
    }
```

## Indexes

| Index | Query it serves |
|---|---|
| `unique (parentId, lower(name)) WHERE deletedAt IS NULL` | name conflicts, enforced by the database rather than by a racing pre-check |
| `btree (parentId, name, id)` | listing one folder with keyset pagination and no sort step |
| `btree (roomId, path varchar_pattern_ops)` | subtree prefix scans: rollup, delete, move, scope checks |
| `gin (name gin_trgm_ops)` | substring name search |
| `unique Share(tokenHash)` | public-link lookup in one indexed hit |
| `unique Share(nodeId, granteeEmail)` | re-inviting the same address is an upsert, not an error |
```

- [ ] **Step 3: Write the README**

`README.md` — the full outline from the spec §12. Include, in this order:

1. **Live** — frontend URL, backend URL, `/docs` URL, then the demo credentials and the guest link printed by `pnpm seed`.
2. **What it does** — a 30-second GIF or six screenshots: dashboard, folder with files, drag-and-drop upload with progress, conflict dialog, share dialog, guest view.
3. **Local setup** — must work from a clean clone:
   ```bash
   pnpm install
   docker compose up -d
   cp .env.example apps/api/.env
   pnpm --filter api prisma migrate deploy
   pnpm seed
   pnpm dev            # api on :3000, web on :5173
   ```
4. **Architecture** — the request path (browser → Vercel `/api` rewrite → Nest → Postgres + bucket) and the two-phase upload, with the reason the API never touches file bytes.
5. **Data model** — embed `docs/erd.md`, then explain: one `Node` table for folders and files; the materialized `path` and why a string with a trailing slash rather than `uuid[]`; why every room has a root node.
6. **Authorization** — `AccessContext`, the single access query, the error table, and why a stranger gets 404 rather than 403.
7. **How it scales** — the three required answers, with the SQL quoted:
   - *Subtree size and count:* one aggregate over `(roomId, path varchar_pattern_ops)`; `sizeBytes` denormalized onto `Node` so it never joins `FileVersion`; counters by trigger are the next step and are cheap because the rollup is already one query.
   - *100,000 files:* listing is always one folder with keyset pagination on `(parentId, name, id)`; two indexes because they serve two different queries, and a GIN index cannot supply `ORDER BY` at all; `pg_trgm` for search; client-side virtualization above 200 rows; deletes and moves are one UPDATE over a prefix.
   - *Per-user roles:* `Share.role` is already an enum and the resolver already returns a role rather than a boolean; `EDITOR` is one enum value plus one comparison in the guard, with no change to the tree, the path, or any listing query. Overlapping grants already resolve deepest-first.
8. **Edge cases** — the table from spec §10.
9. **Trade-offs and what's next** — spec §11.
10. **Where AI was used** — be specific. Name the two places the first generated answer was **wrong** and was caught: the `path` prefix arithmetic in move (`WHERE path LIKE oldPrefix || '%'` does not match the moved node itself, because a node's path holds only its ancestors), and the NULL semantics of `@@unique([parentId, name, deletedAt])` (NULLs are distinct in PostgreSQL, so that index enforces nothing on live rows — a partial unique index is the fix). Two concrete sentences there are worth more than a paragraph of generalities.

- [ ] **Step 4: Run the full suite locally**

Run:
```bash
docker compose up -d
pnpm install
pnpm --filter api prisma migrate deploy
pnpm lint
pnpm test
pnpm --filter api test:e2e
pnpm build
```
Expected: everything green. Record the actual output; if a step fails, fix it before claiming completion.

- [ ] **Step 5: Push and confirm CI**

```bash
git add .github README.md docs/erd.md
git commit -m "docs: readme with design decisions, erd and scaling answers; ci for api and web"
git push
```
Expected: both CI jobs green, including the `schema.d.ts` drift check.

- [ ] **Step 6: Release verification on the deployed environment**

Walk this list against the live URLs and record the result of each:

1. `curl https://<vercel-host>/api/health` → `{"status":"ok"}`
2. `https://<api-host>/docs` renders and lists every tag.
3. Sign in as `demo@dataroom.app`; the seeded tree appears with real totals.
4. Open a seeded PDF; it renders inline.
5. Upload two PDFs by drag-and-drop; progress advances and both appear.
6. Re-upload one of the same names; the conflict dialog offers new version and keep both.
7. Rename a file to an existing name; a 409 appears inline, not a toast-and-close.
8. Move a folder into its own child; the drop shows no highlight and the dialog disables it.
9. Delete a folder; the dialog states folders, files, bytes and shares affected.
10. Open the seeded guest link in a private window; only the shared subtree is reachable and no mutation control is present.
11. As the owner, revoke that link; the guest's next action reports "no longer active".
12. Share `03 Legal` with a second account; sign in as `counsel@example.com` and confirm the tree starts at `03 Legal`.
13. Search `audit`; hits show their containing folder.
14. Wait out the 15-minute access token or clear it; the next action refreshes silently rather than bouncing to `/login`.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: release verification pass"
git push
```
