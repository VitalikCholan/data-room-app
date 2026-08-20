# Data Room — Plan 05: File Browser, Uploads and Viewer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan set:** this is one of six. Order: 01 foundation → 02 tree API → 03 files & sharing API → 04 web shell → 05 web browser → 06 sharing UI & release. See `2026-08-19-data-room-00-overview.md`.

**Goal:** The product itself — browse folders with breadcrumbs, create, rename, move and delete, drag PDFs in with per-file progress, resolve name conflicts deliberately, and read a document in the browser with its version history.

**Architecture:** `FileBrowser` is a layout shell that fetches nothing; `NodeRow` is presentational. Every mutation lives in its own hook that owns its optimistic update and rollback. The upload queue is the one piece of genuinely client-owned state, so it lives in zustand outside the router and survives navigation. Row-to-folder drag uses native HTML5 DnD; OS file drop uses `DataTransfer`. They are separate mechanisms and share no code.

**Tech Stack:** React 18, TanStack Query 5, `@tanstack/react-virtual`, zustand 4, `XMLHttpRequest` for upload progress, Radix, Vitest + Testing Library.

**Prerequisite:** Plan 04 complete — API client, auth, dashboard working.

**Spec:** `docs/superpowers/specs/2026-08-19-data-room-design.md`

> **SCOPE CUT (Ruling 32, carried from plan 03 — extra credit is out).** The API has no
> version-history or search endpoints, so the task text below is amended:
> - **Task 25** ships the document viewer ONLY. No version-history panel, no restore control,
>   no `useVersions` hook, no version tests. `GET /nodes/:id/content` is the whole contract:
>   a 302 to a 5-minute presigned GET. The viewer must handle its 410 (content withdrawn or
>   overwritten) as a real, user-visible state — that response is reachable in production.
> - **Task 24** conflict prompt offers KEEP_BOTH and cancel only. `NEW_VERSION` does not exist
>   in the API's `onConflict` enum; offering it would 422.
> - No search UI anywhere (no plan task defines one; noted so it is not added by inference).
>
> **Stack reality (from plan 04):** React 19, Vite 8, TS 6 with `erasableSyntaxOnly`,
> Tailwind 4 (`@theme` tokens in src/index.css, no config file), react-router-dom v7 in library
> mode, vitest.config.ts separate from vite.config.ts. `zustand` and `@tanstack/react-virtual`
> are installed. Plan text saying React 18 / zustand 4 means "the installed latest".
>
> **Plan 04 debt this plan must clear:** `send()` in `src/api/client.ts` gives the share token
> precedence over the bearer, so a signed-in owner who opens a share link becomes a guest for
> every later request. Whatever sets the share token must clear it when leaving share routes.
> Batching: Task 21+22 = one dispatch; Task 23+24+25 = one dispatch.

**Done when:** An owner can navigate the whole tree, perform every folder and file operation, drag twenty PDFs in and watch them upload with a single conflict prompt for the whole batch, open one in the viewer, and restore an earlier version — and a share viewer sees the same screens with every mutation control absent.

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
- Mutation controls render only when `role === 'OWNER'`. There is no `if (isGuest)` scattered through components — only an `OwnerOnly` wrapper.
- Commit after every task. Conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`).

---

### Task 21: Access context, browser shell, and the node table

**Files:**
- Create: `apps/web/src/access/AccessProvider.tsx`, `OwnerOnly.tsx`
- Create: `apps/web/src/browser/FileBrowser.tsx`, `Breadcrumbs.tsx`, `BrowserToolbar.tsx`, `NodeTable.tsx`, `NodeRow.tsx`, `NodeTableEmpty.tsx`
- Create: `apps/web/src/browser/hooks/useNodeList.ts`
- Create: `apps/web/src/browser/RoomPage.tsx`
- Modify: `apps/web/src/routes.tsx`
- Test: `apps/web/src/browser/NodeTable.test.tsx`, `apps/web/src/browser/Breadcrumbs.test.tsx`

**Interfaces:**
- Consumes: `api`, `queryKeys`, `formatBytes`, `formatRelativeDate`, `ErrorState`, `TableSkeleton`, `EmptyState`
- Produces:
  - `NodeItem = { id: string; type: 'FOLDER' | 'FILE'; name: string; sizeBytes: number | null; updatedAt: string; currentVersionId: string | null }`
  - `Crumb = { id: string; name: string; type: 'FOLDER' | 'FILE' }`
  - `NodeListResponse = { items: NodeItem[]; nextCursor: string | null; breadcrumbs: Crumb[]; parent: { id: string; name: string; parentId: string | null }; role: 'OWNER' | 'VIEWER'; scopeRootId: string }`
  - `useAccess(): { role: 'OWNER' | 'VIEWER'; scopeRootId: string | null; isOwner: boolean }`
  - `<OwnerOnly>` — renders children only for an owner
  - `useNodeList(roomId, parentId, sort)` — infinite query
  - Routes `/rooms/:roomId` and `/rooms/:roomId/f/:nodeId`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/browser/NodeTable.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { NodeTable } from './NodeTable'
import { AccessContextProvider } from '../access/AccessProvider'
import type { NodeItem } from './hooks/useNodeList'

const items: NodeItem[] = [
  { id: 'f1', type: 'FOLDER', name: 'Financials', sizeBytes: null, updatedAt: new Date().toISOString(), currentVersionId: null },
  { id: 'd1', type: 'FILE', name: 'MSA.pdf', sizeBytes: 2048, updatedAt: new Date().toISOString(), currentVersionId: 'v1' },
]

function renderTable(role: 'OWNER' | 'VIEWER', props: Partial<React.ComponentProps<typeof NodeTable>> = {}) {
  return render(
    <MemoryRouter>
      <AccessContextProvider value={{ role, scopeRootId: 'root', isOwner: role === 'OWNER' }}>
        <NodeTable
          roomId="r1"
          items={items}
          isLoading={false}
          hasMore={false}
          onLoadMore={vi.fn()}
          onRename={vi.fn()}
          onMove={vi.fn()}
          onDelete={vi.fn()}
          onShare={vi.fn()}
          onDropOnFolder={vi.fn()}
          {...props}
        />
      </AccessContextProvider>
    </MemoryRouter>,
  )
}

describe('NodeTable', () => {
  it('renders folders and files with size only on files', () => {
    renderTable('OWNER')
    expect(screen.getByText('Financials')).toBeTruthy()
    expect(screen.getByText('MSA.pdf')).toBeTruthy()
    expect(screen.getByText('2 KB')).toBeTruthy()
  })

  it('links a folder to its route and a file to the viewer route', () => {
    renderTable('OWNER')
    expect(screen.getByRole('link', { name: 'Financials' }).getAttribute('href')).toBe('/rooms/r1/f/f1')
    expect(screen.getByRole('link', { name: 'MSA.pdf' }).getAttribute('href')).toBe('/rooms/r1/file/d1')
  })

  it('offers row actions to an owner', async () => {
    const onRename = vi.fn()
    renderTable('OWNER', { onRename })
    await userEvent.click(screen.getByRole('button', { name: /Actions for MSA.pdf/i }))
    await userEvent.click(screen.getByText('Rename'))
    expect(onRename).toHaveBeenCalledWith(items[1])
  })

  it('hides every mutation action from a viewer', async () => {
    renderTable('VIEWER')
    await userEvent.click(screen.getByRole('button', { name: /Actions for MSA.pdf/i }))
    expect(screen.queryByText('Rename')).toBeNull()
    expect(screen.queryByText('Delete')).toBeNull()
    expect(screen.getByText('Open')).toBeTruthy()
  })

  it('shows the loading skeleton instead of an empty state while fetching', () => {
    renderTable('OWNER', { items: [], isLoading: true })
    expect(screen.queryByText(/Drop PDFs/i)).toBeNull()
  })

  it('shows a load-more control when another page exists', async () => {
    const onLoadMore = vi.fn()
    renderTable('OWNER', { hasMore: true, onLoadMore })
    await userEvent.click(screen.getByRole('button', { name: /Load more/i }))
    expect(onLoadMore).toHaveBeenCalled()
  })
})
```

`apps/web/src/browser/Breadcrumbs.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { Breadcrumbs } from './Breadcrumbs'

describe('Breadcrumbs', () => {
  const crumbs = [
    { id: 'root', name: 'Project Titan', type: 'FOLDER' as const },
    { id: 'legal', name: 'Legal', type: 'FOLDER' as const },
    { id: 'contracts', name: 'Contracts', type: 'FOLDER' as const },
  ]

  it('links every ancestor but not the current folder', () => {
    render(
      <MemoryRouter>
        <Breadcrumbs roomId="r1" crumbs={crumbs} onDropOnCrumb={() => {}} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'Legal' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Contracts' })).toBeNull()
    expect(screen.getByText('Contracts')).toBeTruthy()
  })

  it('renders a single crumb without any link', () => {
    render(
      <MemoryRouter>
        <Breadcrumbs roomId="r1" crumbs={[crumbs[0]]} onDropOnCrumb={() => {}} />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link')).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter web test -- browser`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the access context**

`apps/web/src/access/AccessProvider.tsx`:
```tsx
import { createContext, useContext, useMemo, type ReactNode } from 'react'

export type AccessValue = {
  role: 'OWNER' | 'VIEWER'
  scopeRootId: string | null
  isOwner: boolean
}

const AccessContext = createContext<AccessValue>({ role: 'OWNER', scopeRootId: null, isOwner: true })

/** Exported separately so tests can inject a role without a network round trip. */
export function AccessContextProvider({ value, children }: { value: AccessValue; children: ReactNode }) {
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>
}

/**
 * The listing response carries role and scopeRootId, so the same components serve an
 * owner and a share recipient. Components read the role here rather than branching on
 * "am I a guest" in a dozen places.
 */
export function AccessProvider({ role, scopeRootId, children }: { role: 'OWNER' | 'VIEWER'; scopeRootId: string | null; children: ReactNode }) {
  const value = useMemo<AccessValue>(() => ({ role, scopeRootId, isOwner: role === 'OWNER' }), [role, scopeRootId])
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>
}

export const useAccess = () => useContext(AccessContext)
```

`apps/web/src/access/OwnerOnly.tsx`:
```tsx
import type { ReactNode } from 'react'
import { useAccess } from './AccessProvider'

export function OwnerOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  return useAccess().isOwner ? <>{children}</> : <>{fallback}</>
}
```

- [ ] **Step 4: Implement the listing hook**

`apps/web/src/browser/hooks/useNodeList.ts`:
```ts
import { useInfiniteQuery } from '@tanstack/react-query'
import { api, getShareToken } from '../../api/client'
import { queryKeys } from '../../api/keys'

export type NodeItem = {
  id: string
  type: 'FOLDER' | 'FILE'
  name: string
  sizeBytes: number | null
  updatedAt: string
  currentVersionId: string | null
}

export type Crumb = { id: string; name: string; type: 'FOLDER' | 'FILE' }

export type NodeListResponse = {
  items: NodeItem[]
  nextCursor: string | null
  breadcrumbs: Crumb[]
  parent: { id: string; name: string; parentId: string | null }
  role: 'OWNER' | 'VIEWER'
  scopeRootId: string
}

export type SortMode = 'name' | 'updatedAt' | 'size'

export function useNodeList(roomId: string, parentId: string | null, sort: SortMode) {
  return useInfiniteQuery({
    queryKey: queryKeys.nodes.list(roomId, parentId, sort),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ sort, limit: '50' })
      // A guest always names the folder explicitly: their scope root is not the room root,
      // so the API must resolve access from the node rather than from the room.
      if (parentId) params.set('parentId', parentId)
      if (pageParam) params.set('cursor', pageParam)
      if (!parentId && getShareToken()) throw new Error('A share view must always specify a folder')
      return api.get<NodeListResponse>(`/rooms/${roomId}/nodes?${params.toString()}`)
    },
    getNextPageParam: (last) => last.nextCursor,
  })
}
```

- [ ] **Step 5: Implement the presentational components**

`apps/web/src/browser/Breadcrumbs.tsx`:
```tsx
import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Crumb } from './hooks/useNodeList'

/**
 * The API already truncates crumbs at the caller's scope root, so a guest sees the path
 * from the shared folder. Nothing here needs to know that.
 */
export function Breadcrumbs({
  roomId,
  crumbs,
  onDropOnCrumb,
}: {
  roomId: string
  crumbs: Crumb[]
  onDropOnCrumb: (folderId: string) => void
}) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1
        return (
          <span key={crumb.id} className="flex min-w-0 items-center gap-1">
            {index > 0 ? <ChevronRight size={14} className="shrink-0 text-subtle" /> : null}
            {isLast ? (
              <span className="truncate font-medium">{crumb.name}</span>
            ) : (
              <Link
                to={`/rooms/${roomId}/f/${crumb.id}`}
                className="truncate text-subtle hover:text-accent"
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  onDropOnCrumb(crumb.id)
                }}
              >
                {crumb.name}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
```

`apps/web/src/browser/NodeRow.tsx`:
```tsx
import { FileText, Folder, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccess } from '../access/AccessProvider'
import { Button } from '../components/ui/button'
import { DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator, DropdownTrigger } from '../components/ui/dropdown-menu'
import { cn } from '../lib/cn'
import { formatBytes, formatRelativeDate } from '../lib/format'
import type { NodeItem } from './hooks/useNodeList'

export type NodeRowActions = {
  onRename: (node: NodeItem) => void
  onMove: (node: NodeItem) => void
  onDelete: (node: NodeItem) => void
  onShare: (node: NodeItem) => void
  onDropOnFolder: (sourceId: string, targetFolderId: string) => void
}

/** Presentational: no queries, no mutations. Everything arrives as a prop. */
export function NodeRow({ roomId, node, actions }: { roomId: string; node: NodeItem; actions: NodeRowActions }) {
  const { isOwner } = useAccess()
  const [dropTarget, setDropTarget] = useState(false)
  const href = node.type === 'FOLDER' ? `/rooms/${roomId}/f/${node.id}` : `/rooms/${roomId}/file/${node.id}`

  return (
    <div
      className={cn(
        'flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 hover:bg-muted/60',
        dropTarget && 'bg-accent/10 ring-1 ring-inset ring-accent',
      )}
      draggable={isOwner}
      onDragStart={(e) => e.dataTransfer.setData('application/x-node-id', node.id)}
      onDragOver={(e) => {
        if (!isOwner || node.type !== 'FOLDER') return
        const sourceId = e.dataTransfer.types.includes('application/x-node-id')
        if (!sourceId) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropTarget(true)
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(e) => {
        setDropTarget(false)
        if (!isOwner || node.type !== 'FOLDER') return
        e.preventDefault()
        e.stopPropagation()
        const sourceId = e.dataTransfer.getData('application/x-node-id')
        // Dropping a folder onto itself is the one cycle the UI can rule out for free.
        if (sourceId && sourceId !== node.id) actions.onDropOnFolder(sourceId, node.id)
      }}
    >
      {node.type === 'FOLDER' ? (
        <Folder size={16} className="shrink-0 text-accent" />
      ) : (
        <FileText size={16} className="shrink-0 text-subtle" />
      )}

      <Link to={href} className="min-w-0 flex-1 truncate text-sm hover:text-accent">
        {node.name}
      </Link>

      <span className="w-20 shrink-0 text-right text-xs text-subtle">
        {node.type === 'FILE' && node.sizeBytes !== null ? formatBytes(node.sizeBytes) : '—'}
      </span>
      <span className="hidden w-28 shrink-0 text-right text-xs text-subtle sm:inline">{formatRelativeDate(node.updatedAt)}</span>

      <DropdownMenu>
        <DropdownTrigger asChild>
          <Button size="icon" variant="ghost" aria-label={`Actions for ${node.name}`}>
            <MoreHorizontal size={16} />
          </Button>
        </DropdownTrigger>
        <DropdownContent>
          <DropdownItem onSelect={() => window.location.assign(href)}>Open</DropdownItem>
          {isOwner ? (
            <>
              <DropdownSeparator />
              <DropdownItem onSelect={() => actions.onRename(node)}>Rename</DropdownItem>
              <DropdownItem onSelect={() => actions.onMove(node)}>Move…</DropdownItem>
              <DropdownItem onSelect={() => actions.onShare(node)}>Share…</DropdownItem>
              <DropdownSeparator />
              <DropdownItem danger onSelect={() => actions.onDelete(node)}>
                Delete
              </DropdownItem>
            </>
          ) : null}
        </DropdownContent>
      </DropdownMenu>
    </div>
  )
}
```

`apps/web/src/browser/NodeTableEmpty.tsx`:
```tsx
import type { ReactNode } from 'react'
import { useAccess } from '../access/AccessProvider'
import { EmptyState } from '../components/EmptyState'

export function NodeTableEmpty({ searchTerm, action }: { searchTerm?: string; action?: ReactNode }) {
  const { isOwner } = useAccess()

  if (searchTerm) return <EmptyState title={`No files match "${searchTerm}"`} hint="Try a shorter term, or clear the search." action={action} />
  if (!isOwner) return <EmptyState title="This folder is empty" />
  return <EmptyState title="This folder is empty" hint="Drop PDFs here or create a folder to get started." action={action} />
}
```

`apps/web/src/browser/NodeTable.tsx`:
```tsx
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'
import { Button } from '../components/ui/button'
import { TableSkeleton } from '../components/Skeleton'
import { NodeRow, type NodeRowActions } from './NodeRow'
import { NodeTableEmpty } from './NodeTableEmpty'
import type { NodeItem } from './hooks/useNodeList'

const VIRTUALIZE_ABOVE = 200
const ROW_HEIGHT = 45

export function NodeTable({
  roomId,
  items,
  isLoading,
  hasMore,
  onLoadMore,
  emptyAction,
  searchTerm,
  ...actions
}: {
  roomId: string
  items: NodeItem[]
  isLoading: boolean
  hasMore: boolean
  onLoadMore: () => void
  emptyAction?: React.ReactNode
  searchTerm?: string
} & NodeRowActions) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  if (isLoading && items.length === 0) return <TableSkeleton rows={6} />
  if (items.length === 0) return <NodeTableEmpty searchTerm={searchTerm} action={emptyAction} />

  // Below the threshold, plain rows keep the DOM simple and the a11y tree intact.
  if (items.length <= VIRTUALIZE_ABOVE) {
    return (
      <div>
        {items.map((node) => (
          <NodeRow key={node.id} roomId={roomId} node={node} actions={actions} />
        ))}
        {hasMore ? <LoadMore onLoadMore={onLoadMore} /> : null}
      </div>
    )
  }

  return (
    <div>
      <div ref={scrollRef} className="max-h-[65vh] overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => (
            <div
              key={items[virtualRow.index].id}
              style={{ position: 'absolute', top: virtualRow.start, left: 0, right: 0 }}
            >
              <NodeRow roomId={roomId} node={items[virtualRow.index]} actions={actions} />
            </div>
          ))}
        </div>
      </div>
      {hasMore ? <LoadMore onLoadMore={onLoadMore} /> : null}
    </div>
  )
}

const LoadMore = ({ onLoadMore }: { onLoadMore: () => void }) => (
  <div className="flex justify-center border-t border-border py-3">
    <Button onClick={onLoadMore}>Load more</Button>
  </div>
)
```

`apps/web/src/browser/BrowserToolbar.tsx`:
```tsx
import { FolderPlus, Upload } from 'lucide-react'
import { OwnerOnly } from '../access/OwnerOnly'
import { Button } from '../components/ui/button'
import type { SortMode } from './hooks/useNodeList'

export function BrowserToolbar({
  sort,
  onSortChange,
  onCreateFolder,
  onPickFiles,
  children,
}: {
  sort: SortMode
  onSortChange: (sort: SortMode) => void
  onCreateFolder: () => void
  onPickFiles: () => void
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
      {children}
      <div className="flex-1" />
      <label className="sr-only" htmlFor="sort">
        Sort by
      </label>
      <select
        id="sort"
        value={sort}
        onChange={(e) => onSortChange(e.target.value as SortMode)}
        className="h-8 rounded-md border border-border bg-surface px-2 text-sm"
      >
        <option value="name">Name</option>
        <option value="updatedAt">Last modified</option>
        <option value="size">Size</option>
      </select>
      <OwnerOnly>
        <Button size="sm" onClick={onCreateFolder}>
          <FolderPlus size={16} /> New folder
        </Button>
        <Button size="sm" variant="primary" onClick={onPickFiles}>
          <Upload size={16} /> Upload
        </Button>
      </OwnerOnly>
    </div>
  )
}
```

- [ ] **Step 6: Implement the shell and route**

`apps/web/src/browser/FileBrowser.tsx`:
```tsx
import type { ReactNode } from 'react'
import { Breadcrumbs } from './Breadcrumbs'
import type { Crumb } from './hooks/useNodeList'

/** Layout only. It fetches nothing, so it can be reused by the guest route unchanged. */
export function FileBrowser({
  roomId,
  crumbs,
  toolbar,
  children,
  onDropOnCrumb,
  footer,
}: {
  roomId: string
  crumbs: Crumb[]
  toolbar: ReactNode
  children: ReactNode
  onDropOnCrumb: (folderId: string) => void
  footer?: ReactNode
}) {
  return (
    <section className="rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Breadcrumbs roomId={roomId} crumbs={crumbs} onDropOnCrumb={onDropOnCrumb} />
      </div>
      {toolbar}
      {children}
      {footer}
    </section>
  )
}
```

`apps/web/src/browser/RoomPage.tsx`:
```tsx
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { ErrorState } from '../components/ErrorState'
import { AccessProvider } from '../access/AccessProvider'
import { BrowserToolbar } from './BrowserToolbar'
import { FileBrowser } from './FileBrowser'
import { NodeTable } from './NodeTable'
import { useNodeList, type NodeItem, type SortMode } from './hooks/useNodeList'

/**
 * The only place in the browser that fetches. Dialogs and the upload queue are wired
 * in by Tasks 22–24; the handlers below are the seams they plug into.
 */
export function RoomPage() {
  const { roomId = '', nodeId } = useParams()
  const [sort, setSort] = useState<SortMode>('name')
  const list = useNodeList(roomId, nodeId ?? null, sort)

  if (list.isError) {
    return (
      <AppShell>
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      </AppShell>
    )
  }

  const first = list.data?.pages[0]
  const items: NodeItem[] = list.data?.pages.flatMap((page) => page.items) ?? []
  const currentFolderId = first?.parent.id ?? nodeId ?? null

  return (
    <AccessProvider role={first?.role ?? 'OWNER'} scopeRootId={first?.scopeRootId ?? null}>
      <AppShell>
        <FileBrowser
          roomId={roomId}
          crumbs={first?.breadcrumbs ?? []}
          onDropOnCrumb={() => undefined}
          toolbar={
            <BrowserToolbar sort={sort} onSortChange={setSort} onCreateFolder={() => undefined} onPickFiles={() => undefined} />
          }
        >
          <NodeTable
            roomId={roomId}
            items={items}
            isLoading={list.isPending}
            hasMore={Boolean(list.hasNextPage)}
            onLoadMore={() => void list.fetchNextPage()}
            onRename={() => undefined}
            onMove={() => undefined}
            onDelete={() => undefined}
            onShare={() => undefined}
            onDropOnFolder={() => undefined}
          />
        </FileBrowser>
      </AppShell>
    </AccessProvider>
  )
}
```

Add to `apps/web/src/routes.tsx`, inside `<Routes>`:
```tsx
      <Route
        path="/rooms/:roomId"
        element={
          <RequireAuth>
            <RoomPage />
          </RequireAuth>
        }
      />
      <Route
        path="/rooms/:roomId/f/:nodeId"
        element={
          <RequireAuth>
            <RoomPage />
          </RequireAuth>
        }
      />
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter web test -- browser`
Expected: all eight PASS. The decisive one: a `VIEWER` sees `Open` and nothing else in the row menu.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/access apps/web/src/browser apps/web/src/routes.tsx
git commit -m "feat(web): access context, file browser shell, node table with virtualization"
```

---

### Task 22: Folder creation, rename, and delete with a real warning

**Files:**
- Create: `apps/web/src/browser/hooks/useNodeMutations.ts`
- Create: `apps/web/src/browser/dialogs/CreateFolderDialog.tsx`, `RenameDialog.tsx`, `DeleteDialog.tsx`
- Modify: `apps/web/src/browser/RoomPage.tsx`
- Test: `apps/web/src/browser/dialogs/DeleteDialog.test.tsx`, `RenameDialog.test.tsx`

**Interfaces:**
- Consumes: `api`, `queryKeys`, `useNodeList` types, `Dialog`, `Button`, `Input`
- Produces:
  - `useCreateFolder(roomId, parentId, sort)`, `useRenameNode(roomId, parentId, sort)`, `useDeleteNode(roomId, parentId, sort)`, `useMoveNode(roomId, parentId, sort)`
  - `useDeletionPreview(nodeId, enabled)` → `{ folders, files, bytes, activeShares }`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/browser/dialogs/DeleteDialog.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { DeleteDialog } from './DeleteDialog'
import type { NodeItem } from '../hooks/useNodeList'

const folder: NodeItem = {
  id: 'f1',
  type: 'FOLDER',
  name: 'Legal',
  sizeBytes: null,
  updatedAt: new Date().toISOString(),
  currentVersionId: null,
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function renderDialog(node: NodeItem, onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <DeleteDialog roomId="r1" parentId="root" sort="name" node={node} onClose={onClose} />
      </QueryClientProvider>,
    ),
  }
}

describe('DeleteDialog', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('states exactly what will be destroyed, including shares', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ folders: 2, files: 7, bytes: 3_145_728, activeShares: 3 })))
    renderDialog(folder)
    await waitFor(() => expect(screen.getByText(/7 files/)).toBeTruthy())
    expect(screen.getByText(/2 folders/)).toBeTruthy()
    expect(screen.getByText(/3 MB/)).toBeTruthy()
    expect(screen.getByText(/3 people lose access/i)).toBeTruthy()
  })

  it('omits the share warning when nothing is shared', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ folders: 0, files: 1, bytes: 1024, activeShares: 0 })))
    renderDialog(folder)
    await waitFor(() => expect(screen.getByText(/1 file/)).toBeTruthy())
    expect(screen.queryByText(/lose access/i)).toBeNull()
  })

  it('keeps the confirm button disabled until the preview has loaded', async () => {
    let resolvePreview: (value: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => new Promise<Response>((resolve) => (resolvePreview = resolve))),
    )
    renderDialog(folder)
    expect(screen.getByRole('button', { name: /Delete/i })).toHaveProperty('disabled', true)
    resolvePreview(json({ folders: 0, files: 0, bytes: 0, activeShares: 0 }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Delete/i })).toHaveProperty('disabled', false))
  })

  it('deletes and closes on confirm', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'DELETE' ? json({ id: 'f1', deletedNodes: 3 }) : json({ folders: 1, files: 2, bytes: 2048, activeShares: 0 })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { onClose } = renderDialog(folder)
    await waitFor(() => expect(screen.getByRole('button', { name: /Delete/i })).toHaveProperty('disabled', false))
    await userEvent.click(screen.getByRole('button', { name: /Delete/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'DELETE')).toBe(true)
  })
})
```

`apps/web/src/browser/dialogs/RenameDialog.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RenameDialog } from './RenameDialog'
import type { NodeItem } from '../hooks/useNodeList'

const file: NodeItem = {
  id: 'd1',
  type: 'FILE',
  name: 'MSA.pdf',
  sizeBytes: 1024,
  updatedAt: new Date().toISOString(),
  currentVersionId: 'v1',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return {
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <RenameDialog roomId="r1" parentId="root" sort="name" node={file} onClose={onClose} />
      </QueryClientProvider>,
    ),
  }
}

describe('RenameDialog', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('pre-fills the current name and selects the stem, not the extension', () => {
    renderDialog()
    const input = screen.getByLabelText(/Name/i) as HTMLInputElement
    expect(input.value).toBe('MSA.pdf')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('MSA'.length)
  })

  it('rejects a slash before sending anything', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderDialog()
    const input = screen.getByLabelText(/Name/i)
    await userEvent.clear(input)
    await userEvent.type(input, 'a/b.pdf')
    await userEvent.click(screen.getByRole('button', { name: /Save/i }))
    expect(screen.getByRole('alert').textContent).toMatch(/cannot contain/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a 409 inline instead of closing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ code: 'NAME_CONFLICT', message: 'That name is taken in this folder' }, 409)))
    const { onClose } = renderDialog()
    const input = screen.getByLabelText(/Name/i)
    await userEvent.clear(input)
    await userEvent.type(input, 'NDA.pdf')
    await userEvent.click(screen.getByRole('button', { name: /Save/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/taken/i))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes after a successful rename', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ id: 'd1', name: 'NDA.pdf' })))
    const { onClose } = renderDialog()
    const input = screen.getByLabelText(/Name/i)
    await userEvent.clear(input)
    await userEvent.type(input, 'NDA.pdf')
    await userEvent.click(screen.getByRole('button', { name: /Save/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter web test -- dialogs`
Expected: FAIL — dialog modules missing.

- [ ] **Step 3: Implement the mutation hooks**

`apps/web/src/browser/hooks/useNodeMutations.ts`:
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { queryKeys } from '../../api/keys'
import type { NodeItem, NodeListResponse, SortMode } from './useNodeList'

type ListKey = ReturnType<typeof queryKeys.nodes.list>
type Pages = { pages: NodeListResponse[]; pageParams: unknown[] }

/** Every mutation hook owns its optimistic update and its rollback. */
function useListInvalidation(roomId: string, parentId: string | null, sort: SortMode) {
  const client = useQueryClient()
  const key: ListKey = queryKeys.nodes.list(roomId, parentId, sort)
  return {
    client,
    key,
    invalidate: () => client.invalidateQueries({ queryKey: key }),
    patchItems: (patch: (items: NodeItem[]) => NodeItem[]) => {
      const previous = client.getQueryData<Pages>(key)
      client.setQueryData<Pages>(key, (data) =>
        data ? { ...data, pages: data.pages.map((page, index) => (index === 0 ? { ...page, items: patch(page.items) } : page)) } : data,
      )
      return previous
    },
    restore: (previous: Pages | undefined) => client.setQueryData(key, previous),
  }
}

export function useCreateFolder(roomId: string, parentId: string, sort: SortMode) {
  const { invalidate } = useListInvalidation(roomId, parentId, sort)
  return useMutation({
    mutationFn: (name: string) => api.post<NodeItem>(`/rooms/${roomId}/folders`, { parentId, name }),
    onSuccess: invalidate,
  })
}

export function useRenameNode(roomId: string, parentId: string | null, sort: SortMode) {
  const { patchItems, restore, invalidate } = useListInvalidation(roomId, parentId, sort)
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch<NodeItem>(`/nodes/${id}`, { name }),
    onMutate: ({ id, name }) => ({ previous: patchItems((items) => items.map((item) => (item.id === id ? { ...item, name } : item))) }),
    onError: (_error, _vars, context) => restore(context?.previous),
    onSettled: invalidate,
  })
}

export function useDeleteNode(roomId: string, parentId: string | null, sort: SortMode) {
  const { patchItems, restore, invalidate, client } = useListInvalidation(roomId, parentId, sort)
  return useMutation({
    mutationFn: (id: string) => api.del<{ id: string; deletedNodes: number }>(`/nodes/${id}`),
    onMutate: (id) => ({ previous: patchItems((items) => items.filter((item) => item.id !== id)) }),
    onError: (_error, _vars, context) => restore(context?.previous),
    onSettled: () => {
      void invalidate()
      // Room totals on the dashboard change too.
      void client.invalidateQueries({ queryKey: queryKeys.rooms.all })
    },
  })
}

export function useMoveNode(roomId: string, parentId: string | null, sort: SortMode) {
  const { patchItems, restore, invalidate, client } = useListInvalidation(roomId, parentId, sort)
  return useMutation({
    mutationFn: ({ id, targetParentId }: { id: string; targetParentId: string }) =>
      api.post<NodeItem>(`/nodes/${id}/move`, { targetParentId }),
    // The row leaves the current folder, so removing it optimistically is correct.
    onMutate: ({ id }) => ({ previous: patchItems((items) => items.filter((item) => item.id !== id)) }),
    onError: (_error, _vars, context) => restore(context?.previous),
    onSettled: () => {
      void invalidate()
      void client.invalidateQueries({ queryKey: ['nodes', roomId] })
    },
  })
}

export function useDeletionPreview(nodeId: string | null) {
  return useQuery({
    queryKey: queryKeys.nodes.deletionPreview(nodeId ?? 'none'),
    enabled: Boolean(nodeId),
    queryFn: () => api.get<{ folders: number; files: number; bytes: number; activeShares: number }>(`/nodes/${nodeId}/deletion-preview`),
  })
}
```

- [ ] **Step 4: Implement the dialogs**

`apps/web/src/browser/dialogs/CreateFolderDialog.tsx`:
```tsx
import { useState } from 'react'
import { ApiError } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { useCreateFolder } from '../hooks/useNodeMutations'
import type { SortMode } from '../hooks/useNodeList'
import { validateNodeName } from './validateNodeName'

export function CreateFolderDialog({
  roomId,
  parentId,
  sort,
  open,
  onClose,
}: {
  roomId: string
  parentId: string
  sort: SortMode
  open: boolean
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useCreateFolder(roomId, parentId, sort)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const problem = validateNodeName(name)
    if (problem) {
      setError(problem)
      return
    }
    try {
      await create.mutateAsync(name.trim())
      setName('')
      setError(null)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the folder')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose} title="New folder">
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="folder-name">
          Name
        </label>
        <Input id="folder-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="02 Financials" />
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Create folder
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
```

`apps/web/src/browser/dialogs/validateNodeName.ts`:
```ts
/** Mirrors the API's SAFE_NAME rule so the user hears about it before a round trip. */
export function validateNodeName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name cannot be empty'
  if (trimmed.length > 255) return 'Name must be 255 characters or fewer'
  if (/[/\\]/.test(trimmed)) return 'Name cannot contain slashes'
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(trimmed)) return 'Name cannot contain control characters'
  return null
}
```

`apps/web/src/browser/dialogs/RenameDialog.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { useRenameNode } from '../hooks/useNodeMutations'
import type { NodeItem, SortMode } from '../hooks/useNodeList'
import { validateNodeName } from './validateNodeName'

export function RenameDialog({
  roomId,
  parentId,
  sort,
  node,
  onClose,
}: {
  roomId: string
  parentId: string | null
  sort: SortMode
  node: NodeItem
  onClose: () => void
}) {
  const [name, setName] = useState(node.name)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rename = useRenameNode(roomId, parentId, sort)

  // Select the stem only — nobody wants to retype ".pdf".
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const dot = node.name.lastIndexOf('.')
    input.focus()
    input.setSelectionRange(0, dot > 0 ? dot : node.name.length)
  }, [node.name])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const problem = validateNodeName(name)
    if (problem) {
      setError(problem)
      return
    }
    if (name.trim() === node.name) {
      onClose()
      return
    }
    try {
      await rename.mutateAsync({ id: node.id, name: name.trim() })
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not rename')
    }
  }

  return (
    <Dialog open onOpenChange={onClose} title={node.type === 'FOLDER' ? 'Rename folder' : 'Rename file'}>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="rename-node">
          Name
        </label>
        <Input id="rename-node" ref={inputRef} value={name} onChange={(e) => setName(e.target.value)} />
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

`apps/web/src/browser/dialogs/DeleteDialog.tsx`:
```tsx
import { toast } from 'sonner'
import { ApiError } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { Skeleton } from '../../components/Skeleton'
import { formatBytes, formatCount } from '../../lib/format'
import { useDeleteNode, useDeletionPreview } from '../hooks/useNodeMutations'
import type { NodeItem, SortMode } from '../hooks/useNodeList'

export function DeleteDialog({
  roomId,
  parentId,
  sort,
  node,
  onClose,
}: {
  roomId: string
  parentId: string | null
  sort: SortMode
  node: NodeItem
  onClose: () => void
}) {
  const preview = useDeletionPreview(node.id)
  const remove = useDeleteNode(roomId, parentId, sort)

  async function confirm() {
    try {
      await remove.mutateAsync(node.id)
      toast.success(`"${node.name}" deleted`)
      onClose()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete')
    }
  }

  return (
    <Dialog
      open
      onOpenChange={onClose}
      title={`Delete "${node.name}"?`}
      description="This cannot be undone."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!preview.data || remove.isPending} onClick={() => void confirm()}>
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </>
      }
    >
      {preview.isPending ? <Skeleton className="h-16 w-full" /> : null}
      {preview.data ? (
        <div className="rounded-md bg-muted px-4 py-3 text-sm text-subtle">
          {node.type === 'FOLDER' ? (
            <ul>
              <li>{formatCount(preview.data.folders, 'folder')}</li>
              <li>{formatCount(preview.data.files, 'file')}</li>
              <li>{formatBytes(preview.data.bytes)} of documents</li>
            </ul>
          ) : (
            <p>{formatBytes(preview.data.bytes)} · all versions</p>
          )}
          {preview.data.activeShares > 0 ? (
            <p className="mt-2 font-medium text-danger">
              {formatCount(preview.data.activeShares, 'active share')} stop working — {preview.data.activeShares} people lose access.
            </p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  )
}
```

- [ ] **Step 5: Wire the dialogs into RoomPage**

Replace the placeholder handlers in `apps/web/src/browser/RoomPage.tsx` with dialog state:
```tsx
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [renaming, setRenaming] = useState<NodeItem | null>(null)
  const [deleting, setDeleting] = useState<NodeItem | null>(null)
```
Pass `onCreateFolder={() => setCreatingFolder(true)}` to the toolbar, `onRename={setRenaming}` and `onDelete={setDeleting}` to the table, and render:
```tsx
  {currentFolderId ? (
    <CreateFolderDialog
      roomId={roomId}
      parentId={currentFolderId}
      sort={sort}
      open={creatingFolder}
      onClose={() => setCreatingFolder(false)}
    />
  ) : null}
  {renaming ? <RenameDialog roomId={roomId} parentId={nodeId ?? null} sort={sort} node={renaming} onClose={() => setRenaming(null)} /> : null}
  {deleting ? <DeleteDialog roomId={roomId} parentId={nodeId ?? null} sort={sort} node={deleting} onClose={() => setDeleting(null)} /> : null}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter web test -- dialogs`
Expected: all eight PASS. The one that carries the requirement "warn the user what will be deleted": the dialog names folders, files, bytes and how many people lose access.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/browser
git commit -m "feat(web): folder create, rename and delete with subtree preview and optimistic updates"
```

---

### Task 23: Move — dialog and drag-and-drop

**Files:**
- Create: `apps/web/src/browser/dialogs/MoveDialog.tsx`, `apps/web/src/browser/FolderPicker.tsx`
- Modify: `apps/web/src/browser/RoomPage.tsx`
- Test: `apps/web/src/browser/dialogs/MoveDialog.test.tsx`

**Interfaces:**
- Consumes: `useMoveNode`, `api`, `queryKeys`
- Produces:
  - `FolderPicker` — lazily expanding folder tree; disables the moving node and its descendants
  - `MoveDialog` — target selection plus a 409 message surface
  - `RoomPage` handles `onDropOnFolder` and `onDropOnCrumb` through the same mutation

- [ ] **Step 1: Write the failing test**

`apps/web/src/browser/dialogs/MoveDialog.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MoveDialog } from './MoveDialog'
import type { NodeItem } from '../hooks/useNodeList'

const moving: NodeItem = {
  id: 'legal',
  type: 'FOLDER',
  name: 'Legal',
  sizeBytes: null,
  updatedAt: new Date().toISOString(),
  currentVersionId: null,
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const rootListing = {
  items: [
    { id: 'legal', type: 'FOLDER', name: 'Legal', sizeBytes: null, updatedAt: new Date().toISOString(), currentVersionId: null },
    { id: 'fin', type: 'FOLDER', name: 'Financials', sizeBytes: null, updatedAt: new Date().toISOString(), currentVersionId: null },
    { id: 'doc', type: 'FILE', name: 'a.pdf', sizeBytes: 10, updatedAt: new Date().toISOString(), currentVersionId: 'v' },
  ],
  nextCursor: null,
  breadcrumbs: [{ id: 'root', name: 'Room', type: 'FOLDER' }],
  parent: { id: 'root', name: 'Room', parentId: null },
  role: 'OWNER',
  scopeRootId: 'root',
}

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return {
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <MoveDialog roomId="r1" parentId="root" rootFolderId="root" sort="name" node={moving} onClose={onClose} />
      </QueryClientProvider>,
    ),
  }
}

describe('MoveDialog', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists only folders as destinations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(rootListing)))
    renderDialog()
    await waitFor(() => expect(screen.getByText('Financials')).toBeTruthy())
    expect(screen.queryByText('a.pdf')).toBeNull()
  })

  it('disables the folder being moved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(rootListing)))
    renderDialog()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Legal' })).toHaveProperty('disabled', true))
  })

  it('moves to the chosen folder and closes', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'POST' ? json({ id: 'legal' }, 201) : json(rootListing)),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { onClose } = renderDialog()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Financials' })).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: 'Financials' }))
    await userEvent.click(screen.getByRole('button', { name: /^Move here$/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const moveCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')
    expect(moveCall?.[0]).toBe('/api/nodes/legal/move')
    expect(JSON.parse((moveCall?.[1] as RequestInit).body as string)).toEqual({ targetParentId: 'fin' })
  })

  it('shows the 409 message when the server rejects the move', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? json({ code: 'NAME_CONFLICT', message: '"Legal" already exists in the destination folder' }, 409)
          : json(rootListing),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { onClose } = renderDialog()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Financials' })).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: 'Financials' }))
    await userEvent.click(screen.getByRole('button', { name: /^Move here$/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already exists/i))
    expect(onClose).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web test -- MoveDialog`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the folder picker**

`apps/web/src/browser/FolderPicker.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Folder } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api/client'
import { queryKeys } from '../api/keys'
import { cn } from '../lib/cn'
import type { NodeListResponse } from './hooks/useNodeList'

/**
 * Expands lazily, one folder per request. `excludeId` removes the node being moved from
 * the tree entirely, which also removes its descendants — so a cycle cannot be selected
 * at all, rather than being selectable and then rejected.
 */
export function FolderPicker({
  roomId,
  folderId,
  folderName,
  excludeId,
  selectedId,
  onSelect,
  depth = 0,
}: {
  roomId: string
  folderId: string
  folderName: string
  excludeId: string
  selectedId: string | null
  onSelect: (id: string) => void
  depth?: number
}) {
  const [expanded, setExpanded] = useState(depth === 0)
  const children = useQuery({
    queryKey: queryKeys.nodes.list(roomId, folderId, 'name'),
    enabled: expanded,
    queryFn: () => api.get<NodeListResponse>(`/rooms/${roomId}/nodes?parentId=${folderId}&sort=name&limit=200`),
  })

  const subfolders = (children.data?.items ?? []).filter((item) => item.type === 'FOLDER' && item.id !== excludeId)
  const isExcluded = folderId === excludeId

  return (
    <div>
      <div className="flex items-center gap-1" style={{ paddingLeft: depth * 16 }}>
        <button
          type="button"
          aria-label={expanded ? `Collapse ${folderName}` : `Expand ${folderName}`}
          className="rounded p-0.5 text-subtle hover:bg-muted"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button
          type="button"
          disabled={isExcluded}
          onClick={() => onSelect(folderId)}
          className={cn(
            'flex flex-1 items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted disabled:opacity-40',
            selectedId === folderId && 'bg-accent/10 text-accent',
          )}
        >
          <Folder size={14} /> {folderName}
        </button>
      </div>

      {expanded
        ? subfolders.map((folder) => (
            <FolderPicker
              key={folder.id}
              roomId={roomId}
              folderId={folder.id}
              folderName={folder.name}
              excludeId={excludeId}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))
        : null}
    </div>
  )
}
```

`apps/web/src/browser/dialogs/MoveDialog.tsx`:
```tsx
import { useState } from 'react'
import { toast } from 'sonner'
import { ApiError } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { FolderPicker } from '../FolderPicker'
import { useMoveNode } from '../hooks/useNodeMutations'
import type { NodeItem, SortMode } from '../hooks/useNodeList'

export function MoveDialog({
  roomId,
  parentId,
  rootFolderId,
  sort,
  node,
  onClose,
}: {
  roomId: string
  parentId: string | null
  rootFolderId: string
  sort: SortMode
  node: NodeItem
  onClose: () => void
}) {
  const [target, setTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const move = useMoveNode(roomId, parentId, sort)

  async function submit() {
    if (!target) return
    setError(null)
    try {
      await move.mutateAsync({ id: node.id, targetParentId: target })
      toast.success(`Moved "${node.name}"`)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not move this item')
    }
  }

  return (
    <Dialog
      open
      onOpenChange={onClose}
      title={`Move "${node.name}"`}
      description="Pick a destination folder."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!target || move.isPending} onClick={() => void submit()}>
            {move.isPending ? 'Moving…' : 'Move here'}
          </Button>
        </>
      }
    >
      <div className="max-h-72 overflow-auto rounded-md border border-border p-2">
        <FolderPicker
          roomId={roomId}
          folderId={rootFolderId}
          folderName="Data Room root"
          excludeId={node.id}
          selectedId={target}
          onSelect={setTarget}
        />
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Dialog>
  )
}
```

- [ ] **Step 4: Wire drag-and-drop in RoomPage**

Add to `apps/web/src/browser/RoomPage.tsx`:
```tsx
  const move = useMoveNode(roomId, nodeId ?? null, sort)

  const handleDrop = async (sourceId: string, targetFolderId: string) => {
    try {
      await move.mutateAsync({ id: sourceId, targetParentId: targetFolderId })
      toast.success('Moved')
    } catch (error) {
      // The UI already blocks self-drops; a 409 here means a real name clash or a cycle
      // through a folder the row did not know about.
      toast.error(error instanceof ApiError ? error.message : 'Could not move this item')
    }
  }
```
Pass `onDropOnFolder={(sourceId, targetId) => void handleDrop(sourceId, targetId)}` to `NodeTable`, and `onDropOnCrumb={(folderId) => { const sourceId = draggingIdRef.current; if (sourceId) void handleDrop(sourceId, folderId) }}` to `FileBrowser`, where `draggingIdRef` is set in `NodeRow`'s `onDragStart` through a callback prop `onDragStartNode(node.id)`.

Add `[moving, setMoving] = useState<NodeItem | null>(null)`, pass `onMove={setMoving}` to the table, and render:
```tsx
  {moving && first ? (
    <MoveDialog
      roomId={roomId}
      parentId={nodeId ?? null}
      rootFolderId={first.scopeRootId}
      sort={sort}
      node={moving}
      onClose={() => setMoving(null)}
    />
  ) : null}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter web test -- MoveDialog`
Expected: four PASS.

- [ ] **Step 6: Verify drag-and-drop by hand**

Run `pnpm dev`. Create `A/` and `B/`, put a PDF in `A/`, drag the PDF row onto `B/`, then drag `B/` onto itself and onto a breadcrumb.
Expected: dropping onto `B/` moves the file; dropping `B/` onto itself shows no highlight and does nothing; dropping onto a breadcrumb moves the item up.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/browser
git commit -m "feat(web): move via dialog and native drag-and-drop with cycle prevention in the ui"
```

---

### Task 24: Upload queue, drop zone, and the conflict prompt

**Files:**
- Create: `apps/web/src/uploads/uploadStore.ts`, `putWithProgress.ts`, `UploadQueuePanel.tsx`, `UploadQueueItem.tsx`, `DropZoneOverlay.tsx`, `ConflictDialog.tsx`
- Modify: `apps/web/src/browser/RoomPage.tsx`
- Test: `apps/web/src/uploads/uploadStore.test.ts`

**Interfaces:**
- Consumes: `api`, `ApiError`, `queryKeys`
- Produces:
  - `UploadTask = { id; file; roomId; parentId; name; status; progress; error?; nodeId?; versionId?; conflict?: ConflictInfo }`
  - `ConflictInfo = { existingNodeId: string; currentVersionNo: number; existingUpdatedAt: string }`
  - `useUploadStore` — `enqueue(files, roomId, parentId)`, `resolveConflict(taskId, strategy, applyToAll)`, `cancel(taskId)`, `retry(taskId)`, `clearFinished()`, `activeCount()`
  - `putWithProgress(url, file, onProgress, signal): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/uploads/uploadStore.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUploadStore, MAX_CONCURRENT } from './uploadStore'

const pdf = (name: string, size = 1024) => new File([new Uint8Array(size)], name, { type: 'application/pdf' })

const presignResponse = (over: Partial<Record<string, unknown>> = {}) => ({
  nodeId: 'n1',
  versionId: 'v1',
  versionNo: 1,
  blobKey: 'k',
  uploadUrl: 'https://bucket.test/put',
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
  name: 'a.pdf',
  ...over,
})

// Hoisted mocks so the store's imports are replaced before it runs.
const apiMock = vi.hoisted(() => ({ post: vi.fn() }))
const putMock = vi.hoisted(() => ({ putWithProgress: vi.fn() }))

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return { ...actual, api: apiMock }
})
vi.mock('./putWithProgress', () => putMock)

describe('uploadStore', () => {
  beforeEach(() => {
    useUploadStore.setState({ tasks: [] })
    apiMock.post.mockReset()
    putMock.putWithProgress.mockReset()
  })

  it('runs a task through presign, put and confirm', async () => {
    apiMock.post.mockImplementation((path: string) =>
      path.includes('presign') ? Promise.resolve(presignResponse()) : Promise.resolve({ id: 'n1', status: 'ACTIVE' }),
    )
    putMock.putWithProgress.mockResolvedValue(undefined)

    await useUploadStore.getState().enqueue([pdf('a.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(useUploadStore.getState().tasks[0].status).toBe('done'))
    expect(apiMock.post).toHaveBeenCalledTimes(2)
  })

  it(`runs at most ${MAX_CONCURRENT} uploads at once`, async () => {
    let inFlight = 0
    let peak = 0
    apiMock.post.mockImplementation((path: string) => (path.includes('presign') ? Promise.resolve(presignResponse()) : Promise.resolve({})))
    putMock.putWithProgress.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
    })

    await useUploadStore.getState().enqueue([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf'), pdf('d.pdf'), pdf('e.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(useUploadStore.getState().tasks.every((t) => t.status === 'done')).toBe(true), { timeout: 3000 })
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT)
  })

  it('rejects a non-PDF locally without calling the API', async () => {
    await useUploadStore.getState().enqueue([new File(['x'], 'notes.txt', { type: 'text/plain' })], 'r1', 'p1')
    const task = useUploadStore.getState().tasks[0]
    expect(task.status).toBe('error')
    expect(task.error).toMatch(/PDF/i)
    expect(apiMock.post).not.toHaveBeenCalled()
  })

  it('rejects a file over 50 MB locally', async () => {
    const huge = new File([new Uint8Array(10)], 'huge.pdf', { type: 'application/pdf' })
    Object.defineProperty(huge, 'size', { value: 50 * 1024 * 1024 + 1 })
    await useUploadStore.getState().enqueue([huge], 'r1', 'p1')
    expect(useUploadStore.getState().tasks[0].error).toMatch(/50 MB/)
    expect(apiMock.post).not.toHaveBeenCalled()
  })

  it('parks a task in needs-decision on 409 and carries the conflict details', async () => {
    const { ApiError } = await import('../api/client')
    apiMock.post.mockRejectedValueOnce(
      new ApiError(409, 'NAME_CONFLICT', 'exists', { existingNodeId: 'n9', currentVersionNo: 2, existingUpdatedAt: '2026-08-01T00:00:00Z' }),
    )
    await useUploadStore.getState().enqueue([pdf('invoice.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(useUploadStore.getState().tasks[0].status).toBe('needs-decision'))
    expect(useUploadStore.getState().tasks[0].conflict).toMatchObject({ existingNodeId: 'n9', currentVersionNo: 2 })
  })

  it('resolveConflict with applyToAll answers every parked task at once', async () => {
    const { ApiError } = await import('../api/client')
    apiMock.post.mockImplementation((path: string, body: { onConflict?: string }) => {
      if (path.includes('presign') && !body.onConflict) {
        return Promise.reject(new ApiError(409, 'NAME_CONFLICT', 'exists', { existingNodeId: 'n9', currentVersionNo: 1, existingUpdatedAt: 'x' }))
      }
      if (path.includes('presign')) return Promise.resolve(presignResponse())
      return Promise.resolve({})
    })
    putMock.putWithProgress.mockResolvedValue(undefined)

    await useUploadStore.getState().enqueue([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(useUploadStore.getState().tasks.filter((t) => t.status === 'needs-decision')).toHaveLength(3))

    const first = useUploadStore.getState().tasks[0]
    await useUploadStore.getState().resolveConflict(first.id, 'NEW_VERSION', true)
    await vi.waitFor(() => expect(useUploadStore.getState().tasks.every((t) => t.status === 'done')).toBe(true))
    expect(useUploadStore.getState().tasks.some((t) => t.status === 'needs-decision')).toBe(false)
  })

  it('skip drops only the task it was given', async () => {
    const { ApiError } = await import('../api/client')
    apiMock.post.mockRejectedValue(new ApiError(409, 'NAME_CONFLICT', 'exists', { existingNodeId: 'n9', currentVersionNo: 1, existingUpdatedAt: 'x' }))
    await useUploadStore.getState().enqueue([pdf('a.pdf'), pdf('b.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(useUploadStore.getState().tasks.filter((t) => t.status === 'needs-decision')).toHaveLength(2))

    const [first] = useUploadStore.getState().tasks
    await useUploadStore.getState().resolveConflict(first.id, 'SKIP', false)
    expect(useUploadStore.getState().tasks.find((t) => t.id === first.id)?.status).toBe('canceled')
    expect(useUploadStore.getState().tasks.filter((t) => t.status === 'needs-decision')).toHaveLength(1)
  })

  it('cancel aborts the request and marks the task canceled', async () => {
    apiMock.post.mockImplementation((path: string) => (path.includes('presign') ? Promise.resolve(presignResponse()) : Promise.resolve({})))
    putMock.putWithProgress.mockImplementation(
      (_url: string, _file: File, _onProgress: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    )

    await useUploadStore.getState().enqueue([pdf('slow.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(useUploadStore.getState().tasks[0].status).toBe('uploading'))
    useUploadStore.getState().cancel(useUploadStore.getState().tasks[0].id)
    await vi.waitFor(() => expect(useUploadStore.getState().tasks[0].status).toBe('canceled'))
  })

  it('retry restarts from presign because the url may have expired', async () => {
    apiMock.post.mockRejectedValueOnce(new Error('network down'))
    await useUploadStore.getState().enqueue([pdf('a.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(useUploadStore.getState().tasks[0].status).toBe('error'))

    apiMock.post.mockImplementation((path: string) => (path.includes('presign') ? Promise.resolve(presignResponse()) : Promise.resolve({})))
    putMock.putWithProgress.mockResolvedValue(undefined)
    await useUploadStore.getState().retry(useUploadStore.getState().tasks[0].id)
    await vi.waitFor(() => expect(useUploadStore.getState().tasks[0].status).toBe('done'))
    expect(apiMock.post.mock.calls.filter(([path]) => (path as string).includes('presign'))).toHaveLength(2)
  })

  it('reports progress between 0 and 100', async () => {
    apiMock.post.mockImplementation((path: string) => (path.includes('presign') ? Promise.resolve(presignResponse()) : Promise.resolve({})))
    putMock.putWithProgress.mockImplementation(async (_url: string, _file: File, onProgress: (n: number) => void) => {
      onProgress(0.5)
      onProgress(1)
    })
    await useUploadStore.getState().enqueue([pdf('a.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(useUploadStore.getState().tasks[0].progress).toBe(100))
  })

  it('activeCount counts only work in flight', async () => {
    apiMock.post.mockImplementation((path: string) => (path.includes('presign') ? Promise.resolve(presignResponse()) : Promise.resolve({})))
    putMock.putWithProgress.mockResolvedValue(undefined)
    await useUploadStore.getState().enqueue([pdf('a.pdf')], 'r1', 'p1')
    await vi.waitFor(() => expect(useUploadStore.getState().tasks[0].status).toBe('done'))
    expect(useUploadStore.getState().activeCount()).toBe(0)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter web test -- uploadStore`
Expected: FAIL — `Cannot find module './uploadStore'`.

- [ ] **Step 3: Implement the XHR upload**

`apps/web/src/uploads/putWithProgress.ts`:
```ts
/**
 * XMLHttpRequest, not fetch: `upload.onprogress` reports real bytes sent to the bucket.
 * fetch has no portable upload-progress signal, and a progress bar that only knows
 * "sent" versus "done" is worse than none.
 */
export function putWithProgress(url: string, file: File, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url, true)
    xhr.setRequestHeader('Content-Type', file.type || 'application/pdf')

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed with status ${xhr.status}`))
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'))

    signal.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(file)
  })
}
```

- [ ] **Step 4: Implement the store**

`apps/web/src/uploads/uploadStore.ts`:
```ts
import { create } from 'zustand'
import { api, ApiError } from '../api/client'
import { putWithProgress } from './putWithProgress'

export const MAX_CONCURRENT = 3
export const MAX_BYTES = 50 * 1024 * 1024
const ALLOWED_TYPE = 'application/pdf'

export type ConflictInfo = { existingNodeId: string; currentVersionNo: number; existingUpdatedAt: string }
export type ConflictStrategy = 'NEW_VERSION' | 'KEEP_BOTH' | 'SKIP'

export type UploadStatus =
  | 'queued'
  | 'presigning'
  | 'needs-decision'
  | 'uploading'
  | 'confirming'
  | 'done'
  | 'error'
  | 'canceled'

export type UploadTask = {
  id: string
  file: File
  roomId: string
  parentId: string
  name: string
  status: UploadStatus
  progress: number
  error?: string
  nodeId?: string
  versionId?: string
  conflict?: ConflictInfo
  onConflict?: Exclude<ConflictStrategy, 'SKIP'>
  controller?: AbortController
}

type PresignResponse = {
  nodeId: string
  versionId: string
  versionNo: number
  blobKey: string
  uploadUrl: string
  expiresAt: string
  name: string
}

type Store = {
  tasks: UploadTask[]
  onUploaded?: (task: UploadTask) => void
  setOnUploaded: (cb: (task: UploadTask) => void) => void
  enqueue: (files: File[], roomId: string, parentId: string) => Promise<void>
  resolveConflict: (taskId: string, strategy: ConflictStrategy, applyToAll: boolean) => Promise<void>
  cancel: (taskId: string) => void
  retry: (taskId: string) => Promise<void>
  clearFinished: () => void
  activeCount: () => number
  pendingConflict: () => UploadTask | undefined
}

let sequence = 0
const nextId = () => `upload-${++sequence}`

export const useUploadStore = create<Store>((set, get) => {
  const patch = (id: string, changes: Partial<UploadTask>) =>
    set((state) => ({ tasks: state.tasks.map((task) => (task.id === id ? { ...task, ...changes } : task)) }))

  /** Starts as many queued tasks as the concurrency budget allows. */
  function pump() {
    const running = get().tasks.filter((t) => t.status === 'presigning' || t.status === 'uploading' || t.status === 'confirming').length
    const slots = MAX_CONCURRENT - running
    if (slots <= 0) return
    get()
      .tasks.filter((t) => t.status === 'queued')
      .slice(0, slots)
      .forEach((task) => void run(task.id))
  }

  async function run(taskId: string) {
    const task = get().tasks.find((t) => t.id === taskId)
    if (!task) return

    const controller = new AbortController()
    patch(taskId, { status: 'presigning', progress: 0, error: undefined, controller })

    let presigned: PresignResponse
    try {
      presigned = await api.post<PresignResponse>(`/rooms/${task.roomId}/uploads/presign`, {
        parentId: task.parentId,
        name: task.file.name,
        sizeBytes: task.file.size,
        mimeType: ALLOWED_TYPE,
        ...(task.onConflict ? { onConflict: task.onConflict } : {}),
      })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NAME_CONFLICT') {
        // Park it. The user decides; nothing is uploaded meanwhile.
        patch(taskId, { status: 'needs-decision', conflict: error.details as unknown as ConflictInfo })
        pump()
        return
      }
      patch(taskId, { status: 'error', error: error instanceof ApiError ? error.message : 'Could not start the upload' })
      pump()
      return
    }

    patch(taskId, { status: 'uploading', nodeId: presigned.nodeId, versionId: presigned.versionId, name: presigned.name })

    try {
      await putWithProgress(presigned.uploadUrl, task.file, (fraction) => patch(taskId, { progress: Math.round(fraction * 100) }), controller.signal)
    } catch (error) {
      if ((error as DOMException).name === 'AbortError') {
        // The reserved node stays PENDING and is collected by the server sweep.
        patch(taskId, { status: 'canceled' })
      } else {
        patch(taskId, { status: 'error', error: 'Upload failed — retry' })
      }
      pump()
      return
    }

    patch(taskId, { status: 'confirming', progress: 100 })
    try {
      await api.post(`/uploads/${presigned.nodeId}/confirm`, { versionId: presigned.versionId })
      patch(taskId, { status: 'done' })
      const finished = get().tasks.find((t) => t.id === taskId)
      if (finished) get().onUploaded?.(finished)
    } catch (error) {
      patch(taskId, { status: 'error', error: error instanceof ApiError ? error.message : 'Could not finish the upload' })
    }
    pump()
  }

  return {
    tasks: [],
    setOnUploaded: (cb) => set({ onUploaded: cb }),

    enqueue: async (files, roomId, parentId) => {
      const tasks: UploadTask[] = files.map((file) => {
        const base = { id: nextId(), file, roomId, parentId, name: file.name, progress: 0 }
        // Rejected before any request: the server would refuse these too, just later.
        if (file.type !== ALLOWED_TYPE) return { ...base, status: 'error' as const, error: 'Only PDF files are supported' }
        if (file.size > MAX_BYTES) return { ...base, status: 'error' as const, error: 'Files must be 50 MB or smaller' }
        return { ...base, status: 'queued' as const }
      })
      set((state) => ({ tasks: [...state.tasks, ...tasks] }))
      pump()
    },

    resolveConflict: async (taskId, strategy, applyToAll) => {
      const parked = get().tasks.filter((t) => t.status === 'needs-decision')
      const targets = applyToAll ? parked : parked.filter((t) => t.id === taskId)

      targets.forEach((task) => {
        if (strategy === 'SKIP') patch(task.id, { status: 'canceled', conflict: undefined })
        else patch(task.id, { status: 'queued', onConflict: strategy, conflict: undefined })
      })
      pump()
    },

    cancel: (taskId) => {
      const task = get().tasks.find((t) => t.id === taskId)
      task?.controller?.abort()
      if (task && (task.status === 'queued' || task.status === 'needs-decision')) patch(taskId, { status: 'canceled' })
    },

    // Always restarts from presign: a presigned url expires after 15 minutes.
    retry: async (taskId) => {
      patch(taskId, { status: 'queued', progress: 0, error: undefined, conflict: undefined })
      pump()
    },

    clearFinished: () =>
      set((state) => ({ tasks: state.tasks.filter((t) => t.status !== 'done' && t.status !== 'canceled') })),

    activeCount: () =>
      get().tasks.filter((t) => ['queued', 'presigning', 'uploading', 'confirming', 'needs-decision'].includes(t.status)).length,

    pendingConflict: () => get().tasks.find((t) => t.status === 'needs-decision'),
  }
})
```

- [ ] **Step 5: Implement the UI pieces**

`apps/web/src/uploads/UploadQueueItem.tsx`:
```tsx
import { RotateCcw, X } from 'lucide-react'
import { Button } from '../components/ui/button'
import { formatBytes } from '../lib/format'
import { useUploadStore, type UploadTask } from './uploadStore'

const LABELS: Record<UploadTask['status'], string> = {
  queued: 'Waiting',
  presigning: 'Preparing',
  'needs-decision': 'Needs your decision',
  uploading: 'Uploading',
  confirming: 'Finishing',
  done: 'Uploaded',
  error: 'Failed',
  canceled: 'Canceled',
}

export function UploadQueueItem({ task }: { task: UploadTask }) {
  const cancel = useUploadStore((s) => s.cancel)
  const retry = useUploadStore((s) => s.retry)
  const inFlight = task.status === 'uploading' || task.status === 'confirming'

  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{task.name}</span>
        <span className="shrink-0 text-xs text-subtle">{formatBytes(task.file.size)}</span>
        {task.status === 'error' ? (
          <Button size="icon" variant="ghost" aria-label={`Retry ${task.name}`} onClick={() => void retry(task.id)}>
            <RotateCcw size={14} />
          </Button>
        ) : null}
        {inFlight || task.status === 'queued' ? (
          <Button size="icon" variant="ghost" aria-label={`Cancel ${task.name}`} onClick={() => cancel(task.id)}>
            <X size={14} />
          </Button>
        ) : null}
      </div>

      <div className="mt-1 flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded bg-border">
          <div
            className={task.status === 'error' ? 'h-full bg-danger' : 'h-full bg-accent transition-[width]'}
            style={{ width: `${task.status === 'done' ? 100 : task.progress}%` }}
          />
        </div>
        <span className={task.status === 'error' ? 'text-xs text-danger' : 'text-xs text-subtle'}>
          {task.error ?? LABELS[task.status]}
        </span>
      </div>
    </li>
  )
}
```

`apps/web/src/uploads/UploadQueuePanel.tsx`:
```tsx
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../components/ui/button'
import { UploadQueueItem } from './UploadQueueItem'
import { useUploadStore } from './uploadStore'

export function UploadQueuePanel() {
  const tasks = useUploadStore((s) => s.tasks)
  const clearFinished = useUploadStore((s) => s.clearFinished)
  const activeCount = useUploadStore((s) => s.activeCount())
  const [collapsed, setCollapsed] = useState(false)

  // Losing an in-flight upload to a stray tab close is worth one confirmation prompt.
  useEffect(() => {
    if (!activeCount) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [activeCount])

  if (!tasks.length) return null
  const done = tasks.filter((t) => t.status === 'done').length

  return (
    <aside className="fixed bottom-4 right-4 z-20 w-80 overflow-hidden rounded-lg border border-border bg-surface shadow-panel">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex-1 text-sm font-medium">
          {activeCount ? `Uploading ${activeCount} file${activeCount === 1 ? '' : 's'}` : `${done} uploaded`}
        </span>
        {!activeCount ? (
          <Button size="sm" variant="ghost" onClick={clearFinished}>
            Clear
          </Button>
        ) : null}
        <Button size="icon" variant="ghost" aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'} onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </Button>
      </header>
      {collapsed ? null : (
        <ul className="max-h-72 divide-y divide-border overflow-auto">
          {tasks.map((task) => (
            <UploadQueueItem key={task.id} task={task} />
          ))}
        </ul>
      )}
    </aside>
  )
}
```

`apps/web/src/uploads/DropZoneOverlay.tsx`:
```tsx
import { useCallback, useRef, useState, type ReactNode } from 'react'

/**
 * dragenter/dragleave are counted rather than toggled: without the counter the overlay
 * flickers as the pointer crosses child elements. OS folders are not supported, and the
 * copy says so rather than implying otherwise.
 */
export function DropZoneOverlay({ onFiles, children }: { onFiles: (files: File[]) => void; children: ReactNode }) {
  const [active, setActive] = useState(false)
  const depth = useRef(0)

  const isFileDrag = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files')

  const onDragEnter = useCallback((event: React.DragEvent) => {
    if (!isFileDrag(event)) return
    depth.current += 1
    setActive(true)
  }, [])

  const onDragLeave = useCallback((event: React.DragEvent) => {
    if (!isFileDrag(event)) return
    depth.current -= 1
    if (depth.current <= 0) {
      depth.current = 0
      setActive(false)
    }
  }, [])

  return (
    <div
      className="relative"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(event) => {
        if (isFileDrag(event)) event.preventDefault()
      }}
      onDrop={(event) => {
        if (!isFileDrag(event)) return
        event.preventDefault()
        depth.current = 0
        setActive(false)
        onFiles(Array.from(event.dataTransfer.files))
      }}
    >
      {children}
      {active ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/5">
          <p className="rounded-md bg-surface px-3 py-2 text-sm font-medium shadow-panel">Drop PDFs here</p>
        </div>
      ) : null}
    </div>
  )
}
```

`apps/web/src/uploads/ConflictDialog.tsx`:
```tsx
import { useState } from 'react'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { formatRelativeDate } from '../lib/format'
import { useUploadStore } from './uploadStore'

export function ConflictDialog() {
  const task = useUploadStore((s) => s.pendingConflict())
  const resolve = useUploadStore((s) => s.resolveConflict)
  const parkedCount = useUploadStore((s) => s.tasks.filter((t) => t.status === 'needs-decision').length)
  const [applyToAll, setApplyToAll] = useState(false)

  if (!task?.conflict) return null
  const remaining = parkedCount - 1
  const suffixed = task.name.replace(/(\.[^.]+)?$/, ' (2)$1')

  return (
    <Dialog
      open
      onOpenChange={() => void resolve(task.id, 'SKIP', applyToAll)}
      title={`"${task.name}" already exists in this folder`}
      description={`Last changed ${formatRelativeDate(task.conflict.existingUpdatedAt)} · currently v${task.conflict.currentVersionNo}`}
    >
      <div className="flex flex-col gap-2">
        <Button variant="primary" onClick={() => void resolve(task.id, 'NEW_VERSION', applyToAll)}>
          Upload as new version (v{task.conflict.currentVersionNo + 1})
        </Button>
        <Button onClick={() => void resolve(task.id, 'KEEP_BOTH', applyToAll)}>Keep both — {suffixed}</Button>
        <Button variant="ghost" onClick={() => void resolve(task.id, 'SKIP', applyToAll)}>
          Skip this file
        </Button>

        {remaining > 0 ? (
          <label className="mt-2 flex items-center gap-2 text-sm text-subtle">
            <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
            Apply to all {remaining} remaining conflict{remaining === 1 ? '' : 's'}
          </label>
        ) : null}
      </div>
    </Dialog>
  )
}
```

- [ ] **Step 6: Wire uploads into RoomPage**

In `apps/web/src/browser/RoomPage.tsx`:
- wrap the `FileBrowser` in `<DropZoneOverlay onFiles={(files) => void enqueue(files, roomId, currentFolderId!)}>` — only when `first?.role === 'OWNER'`, otherwise render children directly;
- add a hidden `<input type="file" multiple accept="application/pdf" ref={fileInputRef} className="hidden" onChange={…} />` and point the toolbar's `onPickFiles` at `fileInputRef.current?.click()`;
- render `<UploadQueuePanel />` and `<ConflictDialog />` at the end;
- register the invalidation once:
```tsx
  const setOnUploaded = useUploadStore((s) => s.setOnUploaded)
  const queryClient = useQueryClient()
  useEffect(() => {
    setOnUploaded((task) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodes.list(task.roomId, task.parentId, sort) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms.all })
      // The user may have navigated away mid-upload; the toast is how they get back.
      if (task.parentId !== currentFolderId) toast.success(`"${task.name}" uploaded`)
    })
  }, [setOnUploaded, queryClient, sort, currentFolderId])
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter web test -- uploadStore`
Expected: all eleven PASS. The two that matter most: concurrency never exceeds three, and `applyToAll` clears every parked conflict in one decision.

- [ ] **Step 8: Verify by hand**

Run `pnpm dev`, drag five PDFs into a folder, then drag two of the same names again.
Expected: five progress bars, at most three moving at once; the second drag raises one dialog with an "apply to all" checkbox; cancelling mid-upload leaves no row in the listing.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/uploads apps/web/src/browser/RoomPage.tsx
git commit -m "feat(web): upload queue with real progress, drop zone and deliberate conflict resolution"
```

---

### Task 25: Document viewer and version history

**Files:**
- Create: `apps/web/src/files/FileViewerPage.tsx`, `VersionHistoryDrawer.tsx`, `hooks.ts`
- Modify: `apps/web/src/routes.tsx`
- Test: `apps/web/src/files/VersionHistoryDrawer.test.tsx`

**Interfaces:**
- Consumes: `api`, `queryKeys`, `AccessProvider`, `OwnerOnly`
- Produces:
  - `FileVersion = { id: string; versionNo: number; sizeBytes: number; mimeType: string; createdAt: string; isCurrent: boolean }`
  - `useVersions(nodeId)`, `useRestoreVersion(nodeId)`
  - Route `/rooms/:roomId/file/:nodeId`

- [ ] **Step 1: Write the failing test**

`apps/web/src/files/VersionHistoryDrawer.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VersionHistoryDrawer } from './VersionHistoryDrawer'
import { AccessContextProvider } from '../access/AccessProvider'

const versions = [
  { id: 'v3', versionNo: 3, sizeBytes: 4096, mimeType: 'application/pdf', createdAt: new Date().toISOString(), isCurrent: true },
  { id: 'v2', versionNo: 2, sizeBytes: 2048, mimeType: 'application/pdf', createdAt: new Date().toISOString(), isCurrent: false },
]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function renderDrawer(role: 'OWNER' | 'VIEWER') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AccessContextProvider value={{ role, scopeRootId: 'root', isOwner: role === 'OWNER' }}>
        <VersionHistoryDrawer nodeId="d1" onSelectVersion={vi.fn()} selectedVersionId={null} />
      </AccessContextProvider>
    </QueryClientProvider>,
  )
}

describe('VersionHistoryDrawer', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists versions newest first and marks the current one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(versions)))
    renderDrawer('OWNER')
    await waitFor(() => expect(screen.getByText(/Version 3/)).toBeTruthy())
    expect(screen.getByText(/Current/i)).toBeTruthy()
  })

  it('offers restore to an owner for non-current versions only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(versions)))
    renderDrawer('OWNER')
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Restore/i })).toHaveLength(1))
  })

  it('hides restore from a viewer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(versions)))
    renderDrawer('VIEWER')
    await waitFor(() => expect(screen.getByText(/Version 2/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Restore/i })).toBeNull()
  })

  it('calls restore and refreshes the list', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'POST' ? json({ id: 'd1' }, 201) : json(versions)),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderDrawer('OWNER')
    await waitFor(() => expect(screen.getByRole('button', { name: /Restore/i })).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: /Restore/i }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => (url as string).includes('/versions/v2/restore'))).toBe(true),
    )
  })

  it('says so when there is only one version', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([versions[0]])))
    renderDrawer('OWNER')
    await waitFor(() => expect(screen.getByText(/only version/i)).toBeTruthy())
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web test -- VersionHistoryDrawer`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the hooks**

`apps/web/src/files/hooks.ts`:
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { queryKeys } from '../api/keys'

export type FileVersion = {
  id: string
  versionNo: number
  sizeBytes: number
  mimeType: string
  createdAt: string
  isCurrent: boolean
}

export const useVersions = (nodeId: string) =>
  useQuery({ queryKey: queryKeys.nodes.versions(nodeId), queryFn: () => api.get<FileVersion[]>(`/nodes/${nodeId}/versions`) })

export function useRestoreVersion(nodeId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (versionId: string) => api.post(`/nodes/${nodeId}/versions/${versionId}/restore`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.nodes.versions(nodeId) })
      void client.invalidateQueries({ queryKey: ['nodes'] })
    },
  })
}
```

- [ ] **Step 4: Implement the drawer and the viewer**

`apps/web/src/files/VersionHistoryDrawer.tsx`:
```tsx
import { toast } from 'sonner'
import { OwnerOnly } from '../access/OwnerOnly'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'
import { Button } from '../components/ui/button'
import { formatBytes, formatRelativeDate } from '../lib/format'
import { useRestoreVersion, useVersions } from './hooks'

export function VersionHistoryDrawer({
  nodeId,
  selectedVersionId,
  onSelectVersion,
}: {
  nodeId: string
  selectedVersionId: string | null
  onSelectVersion: (versionId: string | null) => void
}) {
  const versions = useVersions(nodeId)
  const restore = useRestoreVersion(nodeId)

  if (versions.isPending) return <Skeleton className="h-32 w-full" />
  if (versions.isError) return <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />

  return (
    <div className="rounded-lg border border-border bg-surface">
      <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Version history</h2>
      {versions.data.length === 1 ? <p className="px-4 py-3 text-sm text-subtle">This is the only version.</p> : null}
      <ul className="divide-y divide-border">
        {versions.data.map((version) => (
          <li key={version.id} className="flex items-center gap-3 px-4 py-2.5">
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => onSelectVersion(version.isCurrent ? null : version.id)}
            >
              <p className="text-sm">
                Version {version.versionNo}
                {version.isCurrent ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-subtle">Current</span> : null}
                {selectedVersionId === version.id ? <span className="ml-2 text-xs text-accent">viewing</span> : null}
              </p>
              <p className="text-xs text-subtle">
                {formatBytes(version.sizeBytes)} · {formatRelativeDate(version.createdAt)}
              </p>
            </button>
            {!version.isCurrent ? (
              <OwnerOnly>
                <Button
                  size="sm"
                  disabled={restore.isPending}
                  onClick={async () => {
                    await restore.mutateAsync(version.id)
                    onSelectVersion(null)
                    toast.success(`Version ${version.versionNo} restored as the current version`)
                  }}
                >
                  Restore
                </Button>
              </OwnerOnly>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
```

`apps/web/src/files/FileViewerPage.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { AccessProvider } from '../access/AccessProvider'
import { AppShell } from '../components/AppShell'
import { ErrorState } from '../components/ErrorState'
import { Button } from '../components/ui/button'
import { getShareToken } from '../api/client'
import { useNodeList } from '../browser/hooks/useNodeList'
import { VersionHistoryDrawer } from './VersionHistoryDrawer'

/**
 * The iframe points at the API, which 302s to a five-minute presigned GET. The browser's
 * own PDF viewer then provides zoom, search and print for free — react-pdf would add a
 * worker bundle and hand-rolled pagination for no requirement we have.
 */
export function FileViewerPage() {
  const { roomId = '', nodeId = '' } = useParams()
  const [version, setVersion] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [slow, setSlow] = useState(false)

  // The listing of the file's own id resolves access and gives us breadcrumbs + role.
  const meta = useNodeList(roomId, nodeId, 'name')

  useEffect(() => {
    setLoaded(false)
    setSlow(false)
    const timer = setTimeout(() => setSlow(true), 5000)
    return () => clearTimeout(timer)
  }, [nodeId, version])

  if (meta.isError) {
    return (
      <AppShell>
        <ErrorState
          error={meta.error}
          action={
            <Link to={`/rooms/${roomId}`} className="text-sm text-accent hover:underline">
              Back to the Data Room
            </Link>
          }
        />
      </AppShell>
    )
  }

  const first = meta.data?.pages[0]
  const contentUrl = `/api/nodes/${nodeId}/content${version ? `?version=${version}` : ''}`
  const shareToken = getShareToken()

  return (
    <AccessProvider role={first?.role ?? 'OWNER'} scopeRootId={first?.scopeRootId ?? null}>
      <AppShell>
        <div className="mb-3 flex items-center gap-2">
          <h1 className="flex-1 truncate text-lg font-semibold">{first?.parent.name ?? 'Document'}</h1>
          <a href={contentUrl} target="_blank" rel="noreferrer">
            <Button size="sm">
              <ExternalLink size={14} /> Open in new tab
            </Button>
          </a>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <div className="min-h-[70vh] overflow-hidden rounded-lg border border-border bg-surface">
            {/* A share token cannot travel on an iframe request, so guests open the tab instead. */}
            {shareToken ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                <p className="text-sm text-subtle">Open this document in a new tab to read it.</p>
                <a href={contentUrl} target="_blank" rel="noreferrer">
                  <Button variant="primary">Open document</Button>
                </a>
              </div>
            ) : (
              <iframe title="Document" src={contentUrl} className="h-full min-h-[70vh] w-full" onLoad={() => setLoaded(true)} />
            )}
            {!shareToken && slow && !loaded ? (
              <div className="border-t border-border p-4 text-center text-sm text-subtle">
                Still loading.{' '}
                <a className="text-accent hover:underline" href={contentUrl} target="_blank" rel="noreferrer">
                  Open in a new tab
                </a>
              </div>
            ) : null}
          </div>

          <VersionHistoryDrawer nodeId={nodeId} selectedVersionId={version} onSelectVersion={setVersion} />
        </div>
      </AppShell>
    </AccessProvider>
  )
}
```

The guest branch is a real constraint, not a shortcut: an `iframe` request carries no custom header, so `X-Share-Token` cannot ride along. Plan 06 makes the guest path work by putting the token in the URL for that one endpoint.

Add the route in `apps/web/src/routes.tsx`:
```tsx
      <Route
        path="/rooms/:roomId/file/:nodeId"
        element={
          <RequireAuth>
            <FileViewerPage />
          </RequireAuth>
        }
      />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter web test -- VersionHistoryDrawer`
Expected: five PASS.

- [ ] **Step 6: Verify by hand**

Run `pnpm dev`, open a PDF, upload the same filename again choosing "new version", reload the viewer, restore version 1.
Expected: the PDF renders inline; history shows three entries after the restore, with the newest marked Current.

- [ ] **Step 7: Run the whole web suite**

Run: `pnpm --filter web test && pnpm --filter web build`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/files apps/web/src/routes.tsx
git commit -m "feat(web): pdf viewer with version history and restore"
```
