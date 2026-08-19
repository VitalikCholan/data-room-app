# Data Room — Plan 04: Web Shell, Auth and Dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan set:** this is one of six. Order: 01 foundation → 02 tree API → 03 files & sharing API → 04 web shell → 05 web browser → 06 sharing UI & release. See `2026-08-19-data-room-00-overview.md`.

**Goal:** Turn the placeholder Vite app from Plan 01 into a real product shell: typed API client with silent token refresh, sign-in and registration, an access context that serves owners and guests alike, and a dashboard of Data Rooms.

**Architecture:** One `apiRequest` wrapper owns auth headers, the single silent-refresh retry, and error translation, so no component ever touches `fetch`. `AuthProvider` holds the session; `AccessProvider` holds `{ role, scopeRootId }` so the same components render for an owner and for a share recipient with no `isGuest` branching. TanStack Query owns all server state; there is no client-side cache of rooms or nodes.

**Tech Stack:** Vite 5, React 18, TypeScript 5, Tailwind 3, Radix primitives, TanStack Query 5, React Router 6, sonner, Vitest + jsdom, `openapi-typescript`.

**Spec:** `docs/superpowers/specs/2026-08-19-data-room-design.md`

**Prerequisite:** Plan 03 complete — `openapi.json` emitted, full API green and deployed.

**Done when:** A visitor can register, sign in (email/password, and Google when configured), see their Data Rooms with real subtree totals, create, rename and delete a room, see what has been shared with them, and stay signed in across an access-token expiry without noticing.

## Global Constraints

- Node 20+, pnpm 9+. Package manager is pnpm workspaces only — no Turborepo, no Nx.
- All packages live under `apps/*`. There is no `packages/` directory and no shared types package.
- `apps/web` must never import from `apps/api` or from `@prisma/client`. Frontend types come only from `apps/web/src/api/schema.d.ts`, generated from `openapi.json`.
- Uploads: PDF only (`application/pdf`), hard cap **50 MB**, enforced only in `UploadsService.confirm` via a bucket `HEAD`.
- Presigned PUT TTL 15 minutes. Presigned GET TTL 5 minutes.
- Share tokens: 32 random bytes, base64url. Store **only** `sha256(token)` in `Share.tokenHash`. Show the token once.
- Access JWT TTL 15 minutes. Refresh cookie TTL 7 days, `httpOnly; Secure; SameSite=Lax; Path=/`.
- Blob keys are always derived server-side as `rooms/{roomId}/nodes/{nodeId}/v{versionNo}`. Never client-supplied.
- HTTP codes are fixed by spec §4.3: 401 unauthenticated · 404 no access (never 403 — it would confirm existence) · 403 role insufficient · 410 deleted ancestor or revoked link · 409 name conflict or move cycle · 413 over 50 MB · 415 wrong MIME · 422 validation.
- `Node.status = PENDING` rows are excluded from every listing, for every caller.
- Soft delete has no user-facing restore. No trash UI. No editor role. No OS folder upload. No audit log.
- Every repository method that reads nodes takes an `AccessContext` and applies its scope prefix. A read query that does not carry scope is a bug.
- Commit after every task. Conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`).

## File Structure — `apps/web/src`

| Path | Responsibility |
|---|---|
| `api/schema.d.ts` | Generated from `openapi.json` — never hand-edited |
| `api/client.ts` | The only place `fetch` is called: headers, silent refresh, `ApiError` |
| `api/keys.ts` | TanStack Query key factory — one source for invalidation |
| `auth/AuthProvider.tsx` | Session state, login, register, logout |
| `auth/LoginPage.tsx`, `RegisterPage.tsx`, `GoogleCallbackPage.tsx` | Unauthenticated screens |
| `auth/RequireAuth.tsx` | Route guard with `returnTo` |
| `access/AccessProvider.tsx` | `{ role, scopeRootId }` for owner and guest |
| `components/ui/*` | Button, Input, Dialog, DropdownMenu, Tabs — thin Radix wrappers |
| `components/AppShell.tsx` | Header, user menu, toast host, error boundary |
| `components/ErrorState.tsx`, `EmptyState.tsx`, `Skeleton.tsx` | Shared state presentation |
| `rooms/DashboardPage.tsx` | Owned rooms + shared-with-me |
| `rooms/RoomCard.tsx`, `CreateRoomDialog.tsx`, `RenameRoomDialog.tsx`, `DeleteRoomDialog.tsx` | Room UI |
| `rooms/hooks.ts` | `useRooms`, `useSharedWithMe`, `useCreateRoom`, `useRenameRoom`, `useDeleteRoom` |
| `lib/format.ts` | Byte and date formatting |

---

### Task 18: Tailwind, UI primitives, and the API client

**Files:**
- Create: `apps/web/tailwind.config.ts`, `postcss.config.js`, `src/index.css`
- Create: `apps/web/src/api/client.ts`, `src/api/keys.ts`, `src/lib/cn.ts`, `src/lib/format.ts`
- Create: `apps/web/src/components/ui/button.tsx`, `input.tsx`, `dialog.tsx`, `dropdown-menu.tsx`, `tabs.tsx`
- Create: `apps/web/src/components/EmptyState.tsx`, `ErrorState.tsx`, `Skeleton.tsx`
- Modify: `apps/web/package.json` (Radix + Tailwind deps), `apps/web/src/main.tsx`
- Test: `apps/web/src/api/client.test.ts`, `src/lib/format.test.ts`

**Interfaces:**
- Consumes: `openapi.json` from Plan 03
- Produces:
  - `ApiError { status: number; code: string; message: string; details?: Record<string, unknown> }`
  - `apiRequest<T>(method, path, opts?): Promise<T>` plus `api.get/post/patch/del`
  - `setAccessToken(t: string | null)`, `getAccessToken()`, `setShareToken(t: string | null)`
  - `onUnauthenticated(cb)` — one hook the AuthProvider subscribes to
  - `queryKeys` factory: `session`, `rooms.all`, `rooms.sharedWithMe`, `nodes.list(roomId, parentId, sort)`, `nodes.rollup(id)`, `nodes.deletionPreview(id)`, `nodes.versions(id)`, `nodes.shares(id)`, `search(roomId, q)`, `sharedBootstrap(token)`
  - `formatBytes(n: number): string`, `formatRelativeDate(iso: string): string`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/api/client.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiRequest, getAccessToken, setAccessToken, setShareToken } from './client'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('apiRequest', () => {
  beforeEach(() => {
    setAccessToken(null)
    setShareToken(null)
    vi.restoreAllMocks()
  })

  it('prefixes the base url and returns parsed json', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiRequest('GET', '/rooms')).resolves.toEqual({ ok: true })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/rooms')
  })

  it('attaches the bearer token when signed in', async () => {
    setAccessToken('tok-1')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    await apiRequest('GET', '/rooms')
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
  })

  it('attaches the share token for guests instead of a bearer', async () => {
    setShareToken('share-1')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    await apiRequest('GET', '/rooms/r1/nodes')
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers['X-Share-Token']).toBe('share-1')
    expect(headers.Authorization).toBeUndefined()
  })

  it('refreshes once on 401 and replays the original request', async () => {
    setAccessToken('stale')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'INVALID_CREDENTIALS', message: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'fresh', user: { id: 'u1' } }, 201))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiRequest('GET', '/rooms')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/refresh')
    expect(getAccessToken()).toBe('fresh')
  })

  it('does not attempt a second refresh for the same request', async () => {
    setAccessToken('stale')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'INVALID_CREDENTIALS' }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'fresh' }, 201))
      .mockResolvedValueOnce(jsonResponse({ code: 'INVALID_CREDENTIALS' }, 401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiRequest('GET', '/rooms')).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('clears the session and notifies when refresh itself fails', async () => {
    setAccessToken('stale')
    const onUnauth = vi.fn()
    const { onUnauthenticated } = await import('./client')
    onUnauthenticated(onUnauth)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'INVALID_CREDENTIALS' }, 401))
      .mockResolvedValueOnce(jsonResponse({ code: 'INVALID_CREDENTIALS' }, 401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiRequest('GET', '/rooms')).rejects.toBeInstanceOf(ApiError)
    expect(getAccessToken()).toBeNull()
    expect(onUnauth).toHaveBeenCalled()
  })

  it('never tries to refresh a guest request', async () => {
    setShareToken('share-1')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 'NOT_FOUND' }, 404))
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiRequest('GET', '/rooms/r1/nodes')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces the server error code and details', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 'NAME_CONFLICT', message: 'exists', details: { existingNodeId: 'n1' } }, 409),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiRequest('POST', '/rooms/r/folders', { body: { name: 'x' } })).rejects.toMatchObject({
      status: 409,
      code: 'NAME_CONFLICT',
      details: { existingNodeId: 'n1' },
    })
  })

  it('falls back to a readable message when the body is not json', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })))
    await expect(apiRequest('GET', '/rooms')).rejects.toMatchObject({ status: 502, code: 'UNKNOWN' })
  })

  it('returns undefined for a 204 rather than throwing on empty json', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await expect(apiRequest('DELETE', '/shares/s1')).resolves.toBeUndefined()
  })
})
```

`apps/web/src/lib/format.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { formatBytes } from './format'

describe('formatBytes', () => {
  it('renders zero without a fraction', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('uses binary units', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
  })

  it('keeps one decimal at most', () => {
    expect(formatBytes(1_234_567)).toBe('1.2 MB')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter web test`
Expected: FAIL — `Cannot find module './client'`.

- [ ] **Step 3: Install and configure Tailwind plus Radix**

Add to `apps/web/package.json` dependencies:
```json
"@radix-ui/react-dialog": "^1.1.2",
"@radix-ui/react-dropdown-menu": "^2.1.2",
"@radix-ui/react-tabs": "^1.1.1",
"@radix-ui/react-tooltip": "^1.1.3",
"class-variance-authority": "^0.7.0"
```

`apps/web/tailwind.config.ts`:
```ts
import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: '#ffffff',
        muted: '#f6f7f9',
        border: '#e4e6eb',
        ink: '#101317',
        subtle: '#697280',
        accent: '#1f6feb',
        danger: '#c62828',
      },
      boxShadow: { panel: '0 8px 24px -12px rgba(16, 19, 23, 0.24)' },
    },
  },
  plugins: [],
} satisfies Config
```

`apps/web/postcss.config.js`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } }
```

`apps/web/src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  color-scheme: light;
}

body {
  @apply bg-muted text-ink antialiased;
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
}
```

Import `./index.css` from `main.tsx`.

- [ ] **Step 4: Implement the client, keys, and helpers**

`apps/web/src/api/client.ts`:
```ts
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

let accessToken: string | null = null
let shareToken: string | null = null
let unauthenticatedHandler: (() => void) | null = null

export const setAccessToken = (token: string | null) => {
  accessToken = token
}
export const getAccessToken = () => accessToken
export const setShareToken = (token: string | null) => {
  shareToken = token
}
export const getShareToken = () => shareToken
/** The AuthProvider subscribes here so a dead session redirects exactly once. */
export const onUnauthenticated = (handler: () => void) => {
  unauthenticatedHandler = handler
}

type RequestOptions = { body?: unknown; signal?: AbortSignal }

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { code?: string; message?: string; details?: Record<string, unknown> }
    return new ApiError(res.status, body.code ?? 'UNKNOWN', body.message ?? res.statusText, body.details)
  } catch {
    return new ApiError(res.status, 'UNKNOWN', res.statusText || 'Request failed')
  }
}

async function refreshSession(): Promise<boolean> {
  const res = await fetch(`${BASE_URL}/auth/refresh`, { method: 'POST', credentials: 'include' })
  if (!res.ok) return false
  const body = (await res.json()) as { accessToken: string }
  setAccessToken(body.accessToken)
  return true
}

async function send(method: string, path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  // A guest is identified by the share token alone; mixing in a stale bearer would
  // make the API resolve the wrong identity.
  if (shareToken) headers['X-Share-Token'] = shareToken
  else if (accessToken) headers.Authorization = `Bearer ${accessToken}`

  return fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    credentials: 'include',
    signal: opts.signal,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}

export async function apiRequest<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  let res = await send(method, path, opts)

  // Exactly one silent refresh attempt, and never for a guest — a share token does
  // not expire, so a 401 there means something else is wrong.
  if (res.status === 401 && !shareToken && path !== '/auth/refresh') {
    if (await refreshSession()) {
      res = await send(method, path, opts)
    } else {
      setAccessToken(null)
      unauthenticatedHandler?.()
    }
  }

  if (!res.ok) throw await parseError(res)
  if (res.status === 204 || res.headers.get('Content-Length') === '0') return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => apiRequest<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown) => apiRequest<T>('POST', path, { body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>('PATCH', path, { body }),
  del: <T>(path: string) => apiRequest<T>('DELETE', path),
}
```

`apps/web/src/api/keys.ts`:
```ts
/** One factory so an invalidation can never miss a key by typo. */
export const queryKeys = {
  session: ['session'] as const,
  rooms: {
    all: ['rooms'] as const,
    sharedWithMe: ['rooms', 'shared-with-me'] as const,
  },
  nodes: {
    list: (roomId: string, parentId: string | null, sort: string) => ['nodes', roomId, parentId ?? 'root', sort] as const,
    rollup: (nodeId: string) => ['nodes', nodeId, 'rollup'] as const,
    deletionPreview: (nodeId: string) => ['nodes', nodeId, 'deletion-preview'] as const,
    versions: (nodeId: string) => ['nodes', nodeId, 'versions'] as const,
    shares: (nodeId: string) => ['nodes', nodeId, 'shares'] as const,
  },
  search: (roomId: string, q: string) => ['search', roomId, q] as const,
  sharedBootstrap: (token: string) => ['shared', token] as const,
}
```

`apps/web/src/lib/cn.ts`:
```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))
```

`apps/web/src/lib/format.ts`:
```ts
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  const rounded = Math.round(value * 10) / 10
  return `${rounded} ${UNITS[exponent]}`
}

export function formatRelativeDate(iso: string): string {
  const then = new Date(iso).getTime()
  const minutes = Math.round((Date.now() - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} d ago`
  return new Date(iso).toLocaleDateString()
}

export function formatCount(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}
```

- [ ] **Step 5: Implement the UI primitives**

`apps/web/src/components/ui/button.tsx`:
```tsx
import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:bg-accent/90',
        secondary: 'border border-border bg-surface text-ink hover:bg-muted',
        ghost: 'text-subtle hover:bg-muted hover:text-ink',
        danger: 'bg-danger text-white hover:bg-danger/90',
      },
      size: { sm: 'h-8 px-3', md: 'h-9 px-4', icon: 'h-8 w-8' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(button({ variant, size }), className)} {...props} />
))
Button.displayName = 'Button'
```

`apps/web/src/components/ui/input.tsx`:
```tsx
import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'h-9 w-full rounded-md border border-border bg-surface px-3 text-sm outline-none placeholder:text-subtle focus:border-accent',
      className,
    )}
    {...props}
  />
))
Input.displayName = 'Input'
```

`apps/web/src/components/ui/dialog.tsx`:
```tsx
import * as Primitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  className?: string
}) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 bg-ink/30 backdrop-blur-[1px]" />
        <Primitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-panel',
            className,
          )}
        >
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <Primitive.Title className="text-base font-semibold">{title}</Primitive.Title>
              {description ? <Primitive.Description className="mt-1 text-sm text-subtle">{description}</Primitive.Description> : null}
            </div>
            <Primitive.Close aria-label="Close" className="rounded p-1 text-subtle hover:bg-muted hover:text-ink">
              <X size={16} />
            </Primitive.Close>
          </div>
          {children}
          {footer ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  )
}
```

`apps/web/src/components/ui/dropdown-menu.tsx`:
```tsx
import * as Primitive from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export const DropdownMenu = Primitive.Root
export const DropdownTrigger = Primitive.Trigger

export function DropdownContent({ children }: { children: ReactNode }) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align="end"
        sideOffset={4}
        className="min-w-44 rounded-md border border-border bg-surface p-1 shadow-panel"
      >
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  )
}

export function DropdownItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <Primitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-40',
        danger && 'text-danger',
      )}
    >
      {children}
    </Primitive.Item>
  )
}

export const DropdownSeparator = () => <Primitive.Separator className="my-1 h-px bg-border" />
```

`apps/web/src/components/ui/tabs.tsx`:
```tsx
import * as Primitive from '@radix-ui/react-tabs'
import type { ReactNode } from 'react'

export const Tabs = Primitive.Root

export function TabsList({ children }: { children: ReactNode }) {
  return <Primitive.List className="mb-4 flex gap-1 rounded-md bg-muted p-1">{children}</Primitive.List>
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <Primitive.Trigger
      value={value}
      className="flex-1 rounded px-3 py-1.5 text-sm text-subtle data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-sm"
    >
      {children}
    </Primitive.Trigger>
  )
}

export const TabsContent = Primitive.Content
```

`apps/web/src/components/EmptyState.tsx`:
```tsx
import type { ReactNode } from 'react'

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint ? <p className="max-w-sm text-sm text-subtle">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
```

`apps/web/src/components/ErrorState.tsx`:
```tsx
import type { ReactNode } from 'react'
import { ApiError } from '../api/client'
import { Button } from './ui/button'

/** One place that turns an HTTP code into the wording agreed in the spec. */
export function messageForError(error: unknown): { title: string; hint: string } {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 404:
        return { title: 'Not found', hint: 'This item does not exist, or you do not have access to it.' }
      case 403:
        return { title: 'Read-only access', hint: 'You can view this item but not change it.' }
      case 410:
        return { title: 'No longer available', hint: error.message }
      case 401:
        return { title: 'Session expired', hint: 'Sign in again to continue.' }
      default:
        return { title: 'Something went wrong', hint: error.message }
    }
  }
  return { title: 'Something went wrong', hint: 'Please try again.' }
}

export function ErrorState({ error, onRetry, action }: { error: unknown; onRetry?: () => void; action?: ReactNode }) {
  const { title, hint } = messageForError(error)
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="max-w-sm text-sm text-subtle">{hint}</p>
      <div className="mt-2 flex gap-2">
        {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
        {action}
      </div>
    </div>
  )
}
```

`apps/web/src/components/Skeleton.tsx`:
```tsx
import { cn } from '../lib/cn'

export const Skeleton = ({ className }: { className?: string }) => (
  <div className={cn('animate-pulse rounded bg-border/60', className)} />
)

/** Rows, not a spinner: the table keeps its height so nothing jumps on load. */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="h-4 w-4" />
          <Skeleton className="h-4 flex-1 max-w-[18rem]" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter web test`
Expected: all client and format tests PASS. The refresh tests are the ones that matter — they encode "exactly one retry, never for a guest".

- [ ] **Step 7: Generate the API types**

Run:
```bash
pnpm --filter api openapi:emit
pnpm --filter web openapi:types
pnpm --filter web build
```
Expected: `apps/web/src/api/schema.d.ts` exists and the build passes.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(web): tailwind, radix ui primitives, typed api client with silent refresh"
```

---

### Task 19: Authentication screens and session handling

**Files:**
- Create: `apps/web/src/auth/AuthProvider.tsx`, `LoginPage.tsx`, `RegisterPage.tsx`, `GoogleCallbackPage.tsx`, `RequireAuth.tsx`
- Create: `apps/web/src/components/AppShell.tsx`
- Create: `apps/web/src/routes.tsx`
- Modify: `apps/web/src/App.tsx`, `main.tsx`
- Test: `apps/web/src/auth/AuthProvider.test.tsx`

**Interfaces:**
- Consumes: `api`, `setAccessToken`, `onUnauthenticated`, `queryKeys`
- Produces:
  - `useAuth(): { user: SessionUser | null; status: 'loading' | 'authenticated' | 'anonymous'; login; register; logout; googleEnabled }`
  - `<RequireAuth>` wrapper redirecting to `/login?returnTo=…`
  - Routes `/login`, `/register`, `/auth/callback`

- [ ] **Step 1: Write the failing test**

`apps/web/src/auth/AuthProvider.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './AuthProvider'
import { getAccessToken, setAccessToken } from '../api/client'

function Probe() {
  const { user, status, login, logout } = useAuth()
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.email ?? 'none'}</span>
      <button onClick={() => void login({ email: 'a@b.io', password: 'password123' })}>login</button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  )
}

function renderProbe() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('AuthProvider', () => {
  beforeEach(() => {
    setAccessToken(null)
    vi.restoreAllMocks()
  })

  it('starts anonymous when the refresh cookie is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ code: 'INVALID_CREDENTIALS' }, 401)))
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'))
  })

  it('restores the session from the refresh cookie on first load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ accessToken: 'tok', user: { id: 'u1', email: 'restored@acme.io', name: 'R' } }, 201)),
    )
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('restored@acme.io'))
    expect(getAccessToken()).toBe('tok')
  })

  it('stores the token and user after a successful login', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ code: 'INVALID_CREDENTIALS' }, 401))
      .mockResolvedValueOnce(json({ accessToken: 'tok-2', user: { id: 'u2', email: 'a@b.io', name: 'A' } }, 201))
    vi.stubGlobal('fetch', fetchMock)

    renderProbe()
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'))
    await userEvent.click(screen.getByText('login'))
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('a@b.io'))
  })

  it('clears the session on logout', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: 'tok', user: { id: 'u1', email: 'x@y.io', name: 'X' } }, 201))
      .mockResolvedValueOnce(json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    renderProbe()
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('x@y.io'))
    await userEvent.click(screen.getByText('logout'))
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('none'))
    expect(getAccessToken()).toBeNull()
  })
})
```

Add dev dependencies for this test: `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web test -- AuthProvider`
Expected: FAIL — `Cannot find module './AuthProvider'`.

- [ ] **Step 3: Implement the provider**

`apps/web/src/auth/AuthProvider.tsx`:
```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, onUnauthenticated, setAccessToken, setShareToken } from '../api/client'

export type SessionUser = { id: string; email: string; name: string }
type SessionResponse = { user: SessionUser; accessToken: string }
type Status = 'loading' | 'authenticated' | 'anonymous'

type AuthValue = {
  user: SessionUser | null
  status: Status
  login: (input: { email: string; password: string }) => Promise<void>
  register: (input: { email: string; password: string; name: string }) => Promise<void>
  logout: () => Promise<void>
  adoptSession: (session: SessionResponse) => void
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const navigate = useNavigate()

  const adoptSession = useCallback((session: SessionResponse) => {
    setAccessToken(session.accessToken)
    setShareToken(null)
    setUser(session.user)
    setStatus('authenticated')
  }, [])

  // The access token lives in memory only. On a reload the refresh cookie is what
  // restores the session, so a hard refresh does not sign the user out.
  useEffect(() => {
    let cancelled = false
    void api
      .post<SessionResponse>('/auth/refresh')
      .then((session) => {
        if (!cancelled) adoptSession(session)
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null)
          setStatus('anonymous')
        }
      })
    return () => {
      cancelled = true
    }
  }, [adoptSession])

  useEffect(() => {
    onUnauthenticated(() => {
      setUser(null)
      setStatus('anonymous')
      navigate(`/login?returnTo=${encodeURIComponent(window.location.pathname)}`, { replace: true })
    })
  }, [navigate])

  const value = useMemo<AuthValue>(
    () => ({
      user,
      status,
      adoptSession,
      login: async (input) => adoptSession(await api.post<SessionResponse>('/auth/login', input)),
      register: async (input) => adoptSession(await api.post<SessionResponse>('/auth/register', input)),
      logout: async () => {
        await api.post('/auth/logout').catch((error) => {
          // A failed logout must still clear the client: the cookie is gone either way.
          if (!(error instanceof ApiError)) throw error
        })
        setAccessToken(null)
        setUser(null)
        setStatus('anonymous')
      },
    }),
    [user, status, adoptSession],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
```

- [ ] **Step 4: Implement the screens and route guard**

`apps/web/src/auth/RequireAuth.tsx`:
```tsx
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthProvider'
import { TableSkeleton } from '../components/Skeleton'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <TableSkeleton rows={4} />
  if (status === 'anonymous') return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />
  return <>{children}</>
}
```

`apps/web/src/auth/LoginPage.tsx`:
```tsx
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { useAuth } from './AuthProvider'

const googleEnabled = import.meta.env.VITE_GOOGLE_ENABLED === 'true'

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login({ email, password })
      navigate(params.get('returnTo') ?? '/', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-xl font-semibold">Sign in to Data Room</h1>
        <p className="mt-1 text-sm text-subtle">Secure document sharing for due diligence.</p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="text-sm font-medium" htmlFor="email">
          Email
        </label>
        <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />

        <label className="text-sm font-medium" htmlFor="password">
          Password
        </label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {googleEnabled ? (
        <a
          href="/api/auth/google"
          className="flex h-9 items-center justify-center rounded-md border border-border bg-surface text-sm font-medium hover:bg-muted"
        >
          Continue with Google
        </a>
      ) : null}

      <p className="text-sm text-subtle">
        No account?{' '}
        <Link className="text-accent hover:underline" to="/register">
          Create one
        </Link>
      </p>
    </main>
  )
}
```

`VITE_GOOGLE_ENABLED` keeps an unusable button off the screen when the backend has no Google credentials. Add it to `.env.example` for `apps/web` with a default of `false`.

`apps/web/src/auth/RegisterPage.tsx`:
```tsx
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { useAuth } from './AuthProvider'

export function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const update = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await register(form)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the account')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-xl font-semibold">Create your account</h1>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="text-sm font-medium" htmlFor="name">
          Name
        </label>
        <Input id="name" required value={form.name} onChange={update('name')} />

        <label className="text-sm font-medium" htmlFor="email">
          Email
        </label>
        <Input id="email" type="email" autoComplete="email" required value={form.email} onChange={update('email')} />

        <label className="text-sm font-medium" htmlFor="password">
          Password
        </label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={form.password}
          onChange={update('password')}
        />
        <p className="text-xs text-subtle">At least 8 characters.</p>

        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </Button>
      </form>
      <p className="text-sm text-subtle">
        Already registered?{' '}
        <Link className="text-accent hover:underline" to="/login">
          Sign in
        </Link>
      </p>
    </main>
  )
}
```

`apps/web/src/auth/GoogleCallbackPage.tsx`:
```tsx
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { useAuth } from './AuthProvider'
import type { SessionUser } from './AuthProvider'

/**
 * The API redirects here with the access token in the URL fragment. The fragment is
 * consumed and immediately replaced so the token never lands in history or a referrer.
 */
export function GoogleCallbackPage() {
  const { adoptSession } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('access_token')
    if (!token) {
      navigate('/login', { replace: true })
      return
    }
    window.history.replaceState(null, '', '/auth/callback')
    // The token alone is enough to fetch the profile; refresh already lives in a cookie.
    adoptSession({ accessToken: token, user: { id: '', email: '', name: '' } })
    void api
      .get<SessionUser>('/auth/me')
      .then((user) => adoptSession({ accessToken: token, user }))
      .finally(() => navigate('/', { replace: true }))
  }, [adoptSession, navigate])

  return <p className="p-8 text-sm text-subtle">Finishing sign-in…</p>
}
```

`apps/web/src/components/AppShell.tsx`:
```tsx
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button } from './ui/button'
import { useAuth } from '../auth/AuthProvider'

export function AppShell({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const { user, logout } = useAuth()
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-border bg-surface px-4">
        <Link to="/" className="text-sm font-semibold">
          Data Room
        </Link>
        <div className="flex-1">{right}</div>
        {user ? (
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-subtle sm:inline">{user.email}</span>
            <Button size="sm" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        ) : null}
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}
```

`apps/web/src/routes.tsx`:
```tsx
import { Route, Routes } from 'react-router-dom'
import { LoginPage } from './auth/LoginPage'
import { RegisterPage } from './auth/RegisterPage'
import { GoogleCallbackPage } from './auth/GoogleCallbackPage'
import { RequireAuth } from './auth/RequireAuth'
import { DashboardPage } from './rooms/DashboardPage'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/auth/callback" element={<GoogleCallbackPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <DashboardPage />
          </RequireAuth>
        }
      />
    </Routes>
  )
}
```

`apps/web/src/App.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AuthProvider } from './auth/AuthProvider'
import { AppRoutes } from './routes'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      // 404/403/410 are answers, not failures — retrying them just delays the message.
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status
        if (status && status < 500) return false
        return failureCount < 2
      },
    },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
          <Toaster position="bottom-right" richColors />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter web test -- AuthProvider`
Expected: all four PASS. The important one is session restore from the refresh cookie: a hard reload must not sign the user out.

- [ ] **Step 6: Verify by hand**

Run `pnpm dev`, open `http://localhost:5173/`, register an account, reload the page.
Expected: redirect to `/login` when anonymous; after registering, a reload keeps you signed in.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): auth provider, sign-in and registration screens, app shell"
```

---

### Task 20: Dashboard of Data Rooms

**Files:**
- Create: `apps/web/src/rooms/DashboardPage.tsx`, `RoomCard.tsx`, `CreateRoomDialog.tsx`, `RenameRoomDialog.tsx`, `DeleteRoomDialog.tsx`, `hooks.ts`
- Create: `apps/web/src/rooms/SharedWithMeList.tsx`
- Test: `apps/web/src/rooms/DashboardPage.test.tsx`

**Interfaces:**
- Consumes: `api`, `queryKeys`, `formatBytes`, `formatCount`, `EmptyState`, `ErrorState`, `TableSkeleton`, `Dialog`, `Button`
- Produces:
  - `Room = { id: string; name: string; rootNodeId: string; createdAt: string; rollup: { folders: number; files: number; bytes: number } }`
  - `SharedItem = { shareId: string; roomId: string; roomName: string; nodeId: string; nodeName: string; nodeType: 'FOLDER' | 'FILE'; isWholeRoom: boolean }`
  - `useRooms()`, `useSharedWithMe()`, `useCreateRoom()`, `useRenameRoom()`, `useDeleteRoom()`

- [ ] **Step 1: Write the failing test**

`apps/web/src/rooms/DashboardPage.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage'

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'demo@dataroom.app', name: 'Demo' }, status: 'authenticated', logout: vi.fn() }),
}))

const rooms = [
  { id: 'r1', name: 'Project Titan', rootNodeId: 'n1', createdAt: new Date().toISOString(), rollup: { folders: 4, files: 25, bytes: 5_242_880 } },
]

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('DashboardPage', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows a skeleton, then the rooms with their totals', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => Promise.resolve(json(url.includes('shared-with-me') ? [] : rooms))),
    )
    renderDashboard()
    await waitFor(() => expect(screen.getByText('Project Titan')).toBeTruthy())
    expect(screen.getByText(/25 files/)).toBeTruthy()
    expect(screen.getByText(/5 MB/)).toBeTruthy()
  })

  it('shows a first-run empty state with a create action', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([])))
    renderDashboard()
    await waitFor(() => expect(screen.getByText(/No Data Rooms yet/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /New Data Room/i })).toBeTruthy()
  })

  it('creates a room and refreshes the list', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('shared-with-me')) return Promise.resolve(json([]))
      if (init?.method === 'POST') return Promise.resolve(json({ id: 'r2', name: 'New Room', rootNodeId: 'n2' }, 201))
      return Promise.resolve(json(rooms))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderDashboard()
    await waitFor(() => expect(screen.getByText('Project Titan')).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: /New Data Room/i }))
    await userEvent.type(screen.getByLabelText(/Name/i), 'New Room')
    await userEvent.click(screen.getByRole('button', { name: /^Create$/i }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'POST')).toBe(true))
  })

  it('renders an error state when the list fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ code: 'UNKNOWN', message: 'boom' }, 500)))
    renderDashboard()
    await waitFor(() => expect(screen.getByText(/Something went wrong/i)).toBeTruthy())
  })

  it('lists items shared with the user separately from owned rooms', async () => {
    const shared = [
      { shareId: 's1', roomId: 'r9', roomName: 'Acme', nodeId: 'n9', nodeName: 'Legal', nodeType: 'FOLDER', isWholeRoom: false },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => Promise.resolve(json(url.includes('shared-with-me') ? shared : []))),
    )
    renderDashboard()
    await waitFor(() => expect(screen.getByText('Legal')).toBeTruthy())
    expect(screen.getByText(/Shared with me/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web test -- DashboardPage`
Expected: FAIL — `Cannot find module './DashboardPage'`.

- [ ] **Step 3: Implement the hooks**

`apps/web/src/rooms/hooks.ts`:
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { queryKeys } from '../api/keys'

export type Room = {
  id: string
  name: string
  rootNodeId: string
  createdAt: string
  rollup: { folders: number; files: number; bytes: number }
}

export type SharedItem = {
  shareId: string
  roomId: string
  roomName: string
  nodeId: string
  nodeName: string
  nodeType: 'FOLDER' | 'FILE'
  isWholeRoom: boolean
}

export const useRooms = () => useQuery({ queryKey: queryKeys.rooms.all, queryFn: () => api.get<Room[]>('/rooms') })

export const useSharedWithMe = () =>
  useQuery({ queryKey: queryKeys.rooms.sharedWithMe, queryFn: () => api.get<SharedItem[]>('/rooms/shared-with-me') })

export function useCreateRoom() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api.post<Room>('/rooms', { name }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.rooms.all }),
  })
}

export function useRenameRoom() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch<Room>(`/rooms/${id}`, { name }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.rooms.all }),
  })
}

export function useDeleteRoom() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.del<{ id: string }>(`/rooms/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.rooms.all }),
  })
}
```

- [ ] **Step 4: Implement the dialogs and cards**

`apps/web/src/rooms/CreateRoomDialog.tsx`:
```tsx
import { useState } from 'react'
import { ApiError } from '../api/client'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { useCreateRoom } from './hooks'

export function CreateRoomDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useCreateRoom()

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await create.mutateAsync(name.trim())
      setName('')
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the Data Room')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New Data Room" description="Everything inside stays private until you share it.">
      <form id="create-room" onSubmit={submit} className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="room-name">
          Name
        </label>
        <Input id="room-name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Project Titan" />
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
```

`apps/web/src/rooms/RenameRoomDialog.tsx`:
```tsx
import { useState } from 'react'
import { ApiError } from '../api/client'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { useRenameRoom, type Room } from './hooks'

export function RenameRoomDialog({ room, onClose }: { room: Room | null; onClose: () => void }) {
  const [name, setName] = useState(room?.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const rename = useRenameRoom()

  if (!room) return null

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await rename.mutateAsync({ id: room.id, name: name.trim() })
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not rename')
    }
  }

  return (
    <Dialog open onOpenChange={onClose} title="Rename Data Room">
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="rename-room">
          Name
        </label>
        <Input id="rename-room" autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={rename.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
```

`apps/web/src/rooms/DeleteRoomDialog.tsx`:
```tsx
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { formatBytes, formatCount } from '../lib/format'
import { useDeleteRoom, type Room } from './hooks'

export function DeleteRoomDialog({ room, onClose }: { room: Room | null; onClose: () => void }) {
  const remove = useDeleteRoom()
  if (!room) return null

  return (
    <Dialog
      open
      onOpenChange={onClose}
      title={`Delete "${room.name}"?`}
      description="This cannot be undone. Anyone you shared this Data Room with immediately loses access."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={async () => {
              await remove.mutateAsync(room.id)
              toast.success(`"${room.name}" deleted`)
              onClose()
            }}
          >
            {remove.isPending ? 'Deleting…' : 'Delete Data Room'}
          </Button>
        </>
      }
    >
      <ul className="rounded-md bg-muted px-4 py-3 text-sm text-subtle">
        <li>{formatCount(room.rollup.folders, 'folder')}</li>
        <li>{formatCount(room.rollup.files, 'file')}</li>
        <li>{formatBytes(room.rollup.bytes)} of documents</li>
      </ul>
    </Dialog>
  )
}
```

`apps/web/src/rooms/RoomCard.tsx`:
```tsx
import { MoreHorizontal } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '../components/ui/button'
import { DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator, DropdownTrigger } from '../components/ui/dropdown-menu'
import { formatBytes, formatCount, formatRelativeDate } from '../lib/format'
import type { Room } from './hooks'

export function RoomCard({ room, onRename, onDelete }: { room: Room; onRename: () => void; onDelete: () => void }) {
  return (
    <li className="flex items-center gap-4 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="min-w-0 flex-1">
        <Link to={`/rooms/${room.id}`} className="block truncate text-sm font-medium hover:text-accent">
          {room.name}
        </Link>
        <p className="mt-0.5 text-xs text-subtle">
          {formatCount(room.rollup.folders, 'folder')} · {formatCount(room.rollup.files, 'file')} · {formatBytes(room.rollup.bytes)} ·
          created {formatRelativeDate(room.createdAt)}
        </p>
      </div>
      <DropdownMenu>
        <DropdownTrigger asChild>
          <Button size="icon" variant="ghost" aria-label={`Actions for ${room.name}`}>
            <MoreHorizontal size={16} />
          </Button>
        </DropdownTrigger>
        <DropdownContent>
          <DropdownItem onSelect={onRename}>Rename</DropdownItem>
          <DropdownSeparator />
          <DropdownItem danger onSelect={onDelete}>
            Delete
          </DropdownItem>
        </DropdownContent>
      </DropdownMenu>
    </li>
  )
}
```

`apps/web/src/rooms/SharedWithMeList.tsx`:
```tsx
import { FileText, Folder } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { SharedItem } from './hooks'

export function SharedWithMeList({ items }: { items: SharedItem[] }) {
  if (!items.length) return null
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-semibold">Shared with me</h2>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.shareId} className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
            {item.nodeType === 'FOLDER' ? <Folder size={16} className="text-subtle" /> : <FileText size={16} className="text-subtle" />}
            <div className="min-w-0 flex-1">
              <Link
                to={item.nodeType === 'FOLDER' ? `/rooms/${item.roomId}/f/${item.nodeId}` : `/rooms/${item.roomId}/file/${item.nodeId}`}
                className="block truncate text-sm font-medium hover:text-accent"
              >
                {item.nodeName}
              </Link>
              <p className="text-xs text-subtle">
                {item.isWholeRoom ? 'Entire Data Room' : `in ${item.roomName}`} · read-only
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
```

`apps/web/src/rooms/DashboardPage.tsx`:
```tsx
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { TableSkeleton } from '../components/Skeleton'
import { Button } from '../components/ui/button'
import { CreateRoomDialog } from './CreateRoomDialog'
import { DeleteRoomDialog } from './DeleteRoomDialog'
import { RenameRoomDialog } from './RenameRoomDialog'
import { RoomCard } from './RoomCard'
import { SharedWithMeList } from './SharedWithMeList'
import { useRooms, useSharedWithMe, type Room } from './hooks'

export function DashboardPage() {
  const rooms = useRooms()
  const shared = useSharedWithMe()
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<Room | null>(null)
  const [deleting, setDeleting] = useState<Room | null>(null)

  return (
    <AppShell>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Data Rooms</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus size={16} /> New Data Room
        </Button>
      </div>

      {rooms.isPending ? <TableSkeleton rows={3} /> : null}
      {rooms.isError ? <ErrorState error={rooms.error} onRetry={() => void rooms.refetch()} /> : null}

      {rooms.data && rooms.data.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState
            title="No Data Rooms yet"
            hint="A Data Room is the top-level container for a deal. Create one, then upload documents into folders."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={16} /> New Data Room
              </Button>
            }
          />
        </div>
      ) : null}

      {rooms.data && rooms.data.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rooms.data.map((room) => (
            <RoomCard key={room.id} room={room} onRename={() => setRenaming(room)} onDelete={() => setDeleting(room)} />
          ))}
        </ul>
      ) : null}

      {shared.data ? <SharedWithMeList items={shared.data} /> : null}

      <CreateRoomDialog open={creating} onOpenChange={setCreating} />
      <RenameRoomDialog room={renaming} onClose={() => setRenaming(null)} />
      <DeleteRoomDialog room={deleting} onClose={() => setDeleting(null)} />
    </AppShell>
  )
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter web test -- DashboardPage`
Expected: all five PASS.

- [ ] **Step 6: Verify against the real API**

Run `pnpm dev`, sign in, create two rooms, rename one, delete one.
Expected: totals read `0 folders · 0 files · 0 B` for a new room; the delete dialog states what will be destroyed before you confirm.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/rooms apps/web/src/components apps/web/src/routes.tsx
git commit -m "feat(web): data room dashboard with rollups, create, rename, delete and shared-with-me"
```
