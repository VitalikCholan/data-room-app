import { Test } from '@nestjs/testing'
import { AppModule } from '../src/app.module'
import { MoveService } from '../src/nodes/move.service'
import { AccessContext } from '../src/access/access-context'
import { childPath, ROOT_PATH } from '../src/nodes/node-path'
import {
  createFile,
  createFolder,
  createRoom,
  createUser,
  prisma,
} from './factories'
import { truncateDb } from './support/truncate-db'

describe('MoveService', () => {
  let move: MoveService

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    move = mod.get(MoveService)
  })
  afterAll(async () => {
    await truncateDb(prisma)
    await prisma.$disconnect()
  })

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
    return {
      owner,
      roomId,
      rootId,
      root,
      legal,
      contracts,
      msa,
      financials,
      ctx,
    }
  }

  it('moves a file and rewrites its path', async () => {
    const t = await tree()
    await move.move(t.ctx, t.msa.id, t.financials.id)
    const moved = await prisma.node.findUniqueOrThrow({
      where: { id: t.msa.id },
    })
    expect(moved.parentId).toBe(t.financials.id)
    expect(moved.path).toBe(childPath(t.financials))
  })

  it('rewrites the path of every descendant when a folder moves', async () => {
    const t = await tree()
    await move.move(t.ctx, t.legal.id, t.financials.id)

    const legal = await prisma.node.findUniqueOrThrow({
      where: { id: t.legal.id },
    })
    const contracts = await prisma.node.findUniqueOrThrow({
      where: { id: t.contracts.id },
    })
    const msa = await prisma.node.findUniqueOrThrow({
      where: { id: t.msa.id },
    })

    expect(legal.path).toBe(childPath(t.financials))
    expect(contracts.path).toBe(`${childPath(t.financials)}${t.legal.id}/`)
    expect(msa.path).toBe(
      `${childPath(t.financials)}${t.legal.id}/${t.contracts.id}/`,
    )
  })

  it('refuses to move a folder into its own descendant', async () => {
    const t = await tree()
    await expect(
      move.move(t.ctx, t.legal.id, t.contracts.id),
    ).rejects.toMatchObject({ code: 'MOVE_CYCLE' })
  })

  it('refuses to move a node into itself', async () => {
    const t = await tree()
    await expect(
      move.move(t.ctx, t.legal.id, t.legal.id),
    ).rejects.toMatchObject({ code: 'MOVE_CYCLE' })
  })

  it('refuses to move into a file', async () => {
    const t = await tree()
    await expect(
      move.move(t.ctx, t.financials.id, t.msa.id),
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' })
  })

  it('refuses to move the scope root', async () => {
    const t = await tree()
    await expect(
      move.move(t.ctx, t.rootId, t.financials.id),
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' })
  })

  it('refuses a target in another room', async () => {
    const t = await tree()
    const other = await createUser()
    const otherRoom = await createRoom(other.id)
    await expect(
      move.move(t.ctx, t.msa.id, otherRoom.rootId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reports a name collision in the destination as NAME_CONFLICT', async () => {
    const t = await tree()
    await createFile(t.financials, 'MSA.pdf', t.owner.id)
    await expect(
      move.move(t.ctx, t.msa.id, t.financials.id),
    ).rejects.toMatchObject({ code: 'NAME_CONFLICT' })
  })

  it('is a no-op that still succeeds when the target is the current parent', async () => {
    const t = await tree()
    const before = await prisma.node.findUniqueOrThrow({
      where: { id: t.msa.id },
    })
    await move.move(t.ctx, t.msa.id, t.contracts.id)
    const after = await prisma.node.findUniqueOrThrow({
      where: { id: t.msa.id },
    })
    expect(after.path).toBe(before.path)
    expect(after.parentId).toBe(before.parentId)
  })

  it('leaves the tree untouched when the move fails', async () => {
    const t = await tree()
    await createFile(t.financials, 'MSA.pdf', t.owner.id)
    await expect(
      move.move(t.ctx, t.msa.id, t.financials.id),
    ).rejects.toBeDefined()
    const msa = await prisma.node.findUniqueOrThrow({
      where: { id: t.msa.id },
    })
    expect(msa.path).toBe(childPath(t.contracts))
  })

  /**
   * The brief's own "leaves the tree untouched" case moves a leaf file, which has no
   * descendants — so the descendant-rewrite UPDATE never runs, and a broken rollback
   * of *that* statement specifically would not be caught by it. This moves a folder
   * with descendants into a name-colliding destination, so the descendant rewrite
   * runs and then the final row UPDATE fails on P2002 — proving both statements roll
   * back together, not just the second one.
   */
  it('leaves every descendant path untouched when a folder move fails after the subtree rewrite', async () => {
    const t = await tree()
    await createFolder(t.financials, 'Legal', t.owner.id)

    const before = {
      legal: await prisma.node.findUniqueOrThrow({ where: { id: t.legal.id } }),
      contracts: await prisma.node.findUniqueOrThrow({
        where: { id: t.contracts.id },
      }),
      msa: await prisma.node.findUniqueOrThrow({ where: { id: t.msa.id } }),
    }

    await expect(
      move.move(t.ctx, t.legal.id, t.financials.id),
    ).rejects.toMatchObject({ code: 'NAME_CONFLICT' })

    const after = {
      legal: await prisma.node.findUniqueOrThrow({ where: { id: t.legal.id } }),
      contracts: await prisma.node.findUniqueOrThrow({
        where: { id: t.contracts.id },
      }),
      msa: await prisma.node.findUniqueOrThrow({ where: { id: t.msa.id } }),
    }

    expect(after.legal.path).toBe(before.legal.path)
    expect(after.legal.parentId).toBe(before.legal.parentId)
    expect(after.contracts.path).toBe(before.contracts.path)
    expect(after.msa.path).toBe(before.msa.path)
  })

  /**
   * Every HTTP-reachable path derives `sourceId` from the guard-resolved node named in
   * the route, so an e2e test alone can never construct a source and a ctx from two
   * different rooms. This calls the service directly, the way a future caller with a
   * bug (a cached context, a bulk-move flow assembling its own pair) could, and proves
   * the `roomId = ctx.roomId` filter in the locking query — not `AccessGuard` — is what
   * rejects it.
   */
  it('cross-scope: refuses to move a source node that belongs to another room', async () => {
    const t = await tree()
    const other = await createUser()
    const otherRoom = await createRoom(other.id)
    const otherFile = await createFile(otherRoom.root, 'stray.pdf', other.id)

    await expect(
      move.move(t.ctx, otherFile.id, t.financials.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const stillThere = await prisma.node.findUniqueOrThrow({
      where: { id: otherFile.id },
    })
    expect(stillThere.parentId).toBe(otherRoom.rootId)
  })

  /**
   * Every real caller's `ctx` comes from `AccessResolver`, which only ever hands an
   * OWNER a context rooted at the room root — so `roomId` equality and `withinScope`
   * denote the same rows for every route that exists today. This constructs a ctx
   * scoped to a subtree (`Financials`) narrower than the room, the way a future
   * caller with a genuinely subtree-scoped role could, and moves a source (`MSA.pdf`,
   * living under `Legal/Contracts`) that is in the same room but outside that scope.
   * `roomId = ctx.roomId` alone would let this source through; only `withinScope`
   * excludes it.
   */
  it("cross-scope: refuses to move a source node outside the caller's narrower scope", async () => {
    const t = await tree()
    const scopedCtx: AccessContext = {
      ...t.ctx,
      scopeRootId: t.financials.id,
      scopePath: childPath(t.financials),
    }

    await expect(
      move.move(scopedCtx, t.msa.id, t.financials.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const stillThere = await prisma.node.findUniqueOrThrow({
      where: { id: t.msa.id },
    })
    expect(stillThere.parentId).toBe(t.contracts.id)
  })

  /**
   * The mirror case: the source (a file freshly created inside the caller's scoped
   * folder) is in scope, but the destination (`Legal`) is not. `roomId = ctx.roomId`
   * alone would also let this target through since it is the same room; only
   * `withinScope` on the locking query excludes it.
   */
  it("cross-scope: refuses to move into a target outside the caller's narrower scope", async () => {
    const t = await tree()
    const note = await createFile(t.financials, 'Note.pdf', t.owner.id)
    const scopedCtx: AccessContext = {
      ...t.ctx,
      scopeRootId: t.financials.id,
      scopePath: childPath(t.financials),
    }

    await expect(
      move.move(scopedCtx, note.id, t.legal.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const stillThere = await prisma.node.findUniqueOrThrow({
      where: { id: note.id },
    })
    expect(stillThere.parentId).toBe(t.financials.id)
  })

  /**
   * Positive-path coverage for the same narrower scope, matching the theory in
   * `move.service.ts`: once the locking query has confirmed the source is inside
   * `ctx`'s scope, every descendant's path is necessarily inside it too (a
   * descendant's path always extends its ancestor's), so the `withinScope` clause on
   * the descendant-rewrite UPDATE can never itself flip this outcome — it is
   * defense-in-depth, not a distinguishing condition. This exercises the rewrite
   * under a subtree-scoped ctx anyway, so a future change to that invariant (e.g. a
   * caller resolving `src` by some path other than the guard) has a test watching it.
   */
  it('moves a subtree with descendants under a narrower scope', async () => {
    const t = await tree()
    const amendments = await createFolder(t.legal, 'Amendments', t.owner.id)
    const scopedCtx: AccessContext = {
      ...t.ctx,
      scopeRootId: t.legal.id,
      scopePath: childPath(t.legal),
    }

    await move.move(scopedCtx, t.contracts.id, amendments.id)

    const contracts = await prisma.node.findUniqueOrThrow({
      where: { id: t.contracts.id },
    })
    const msa = await prisma.node.findUniqueOrThrow({ where: { id: t.msa.id } })
    expect(contracts.path).toBe(childPath(amendments))
    expect(msa.path).toBe(`${childPath(amendments)}${t.contracts.id}/`)
  })
})
