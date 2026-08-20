import { Test, TestingModule } from '@nestjs/testing'
import { AppModule } from '../src/app.module'
import { NodesRepository } from '../src/nodes/nodes.repository'
import { childPath } from '../src/nodes/node-path'
import type { AccessContext } from '../src/access/access-context'
import {
  createFile,
  createFolder,
  createRoom,
  createUser,
  prisma,
} from './factories'
import { truncateDb } from './support/truncate-db'

/**
 * The e2e specs prove the HTTP-reachable behaviour, but every request in this app
 * derives `ctx` and the target node from the *same* `AccessGuard` resolution, so an
 * HTTP-level test can never construct a mismatched (ctx, parent) pair — deleting
 * `AND ${withinScope(ctx)}` from `NodesRepository` would not fail a single one of
 * those tests. This file calls the repository directly with a `ctx` scoped to one
 * subtree and a `parent`/`node` from a sibling subtree, the way a future caller with
 * a bug (a cached context, a move/copy flow assembling its own pair) could. Every
 * assertion here has been mutation-checked: with `withinScope`/the in-scope guard
 * removed locally, these tests fail; restored, they pass. See task-10 fix-round-1
 * report for the exact mutation and output.
 */
describe('NodesRepository — cross-scope calls that bypass AccessGuard entirely', () => {
  let mod: TestingModule
  let repo: NodesRepository

  beforeAll(async () => {
    mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    repo = mod.get(NodesRepository)
  })
  afterAll(async () => {
    await truncateDb(prisma)
    await mod.close()
    await prisma.$disconnect()
  })

  async function fixture() {
    const owner = await createUser()
    const { roomId, rootId, root } = await createRoom(owner.id)
    const legal = await createFolder({ ...root, roomId }, 'Legal', owner.id)
    const financials = await createFolder(
      { ...root, roomId },
      'Financials',
      owner.id,
    )
    await createFile(financials, 'secret.pdf', owner.id)
    return { owner, roomId, rootId, root, legal, financials }
  }

  /** A ctx scoped to Legal/ — deliberately never granted anything under Financials/. */
  function legalScopedCtx(
    roomId: string,
    legal: { id: string; path: string },
  ): AccessContext {
    return {
      role: 'VIEWER',
      roomId,
      scopeRootId: legal.id,
      scopePath: childPath(legal),
    }
  }

  it('listChildren returns nothing for Financials/ when ctx is scoped to Legal/', async () => {
    const f = await fixture()
    const ctx = legalScopedCtx(f.roomId, f.legal)

    const { items, nextCursor } = await repo.listChildren(ctx, f.financials, {
      limit: 50,
      sort: 'name',
    })

    expect(items).toEqual([])
    expect(nextCursor).toBeNull()
  })

  it('breadcrumbs returns nothing for a Financials/ node when ctx is scoped to Legal/', async () => {
    const f = await fixture()
    const ctx = legalScopedCtx(f.roomId, f.legal)

    const crumbs = await repo.breadcrumbs(ctx, f.financials)

    expect(crumbs).toEqual([])
  })

  it('takenSiblingNames returns nothing for Financials/ when ctx is scoped to Legal/', async () => {
    const f = await fixture()
    const ctx = legalScopedCtx(f.roomId, f.legal)

    const names = await repo.takenSiblingNames(ctx, f.financials.id)

    expect(names.size).toBe(0)
  })
})
