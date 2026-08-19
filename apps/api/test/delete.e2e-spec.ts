import { Test } from '@nestjs/testing'
import { AppModule } from '../src/app.module'
import { DeleteService } from '../src/nodes/delete.service'
import { AccessResolver } from '../src/access/access.resolver'
import { AccessContext } from '../src/access/access-context'
import { childPath, ROOT_PATH } from '../src/nodes/node-path'
import { hashShareToken } from '../src/access/share-token'
import {
  createFile,
  createFolder,
  createRoom,
  createShare,
  createUser,
  prisma,
} from './factories'
import { truncateDb } from './support/truncate-db'

describe('DeleteService', () => {
  let del: DeleteService
  let resolver: AccessResolver

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    del = mod.get(DeleteService)
    resolver = mod.get(AccessResolver)
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
    const legal = await prisma.node.findUniqueOrThrow({
      where: { id: t.legal.id },
    })
    await expect(del.preview(t.ctx, legal)).resolves.toMatchObject({
      folders: 1,
      files: 2,
      bytes: 5000,
    })
  })

  it('counts the shares that will stop working', async () => {
    const t = await tree()
    await createShare({
      nodeId: t.contracts.id,
      mode: 'PUBLIC_LINK',
      createdById: t.owner.id,
      tokenHash: hashShareToken('t1'),
    })
    await createShare({
      nodeId: t.msa.id,
      mode: 'USER',
      createdById: t.owner.id,
      granteeEmail: 'counsel@example.com',
    })
    const revoked = await createShare({
      nodeId: t.nda.id,
      mode: 'PUBLIC_LINK',
      createdById: t.owner.id,
      tokenHash: hashShareToken('t2'),
    })
    await prisma.share.update({
      where: { id: revoked.id },
      data: { revokedAt: new Date() },
    })

    const legal = await prisma.node.findUniqueOrThrow({
      where: { id: t.legal.id },
    })
    await expect(del.preview(t.ctx, legal)).resolves.toMatchObject({
      activeShares: 2,
    })
  })

  it('tombstones the node and every descendant, not only the subtree root', async () => {
    const t = await tree()
    const legal = await prisma.node.findUniqueOrThrow({
      where: { id: t.legal.id },
    })
    const result = await del.remove(t.ctx, legal)
    expect(result.deletedNodes).toBe(4)

    for (const id of [t.legal.id, t.contracts.id, t.msa.id, t.nda.id]) {
      const row = await prisma.node.findUniqueOrThrow({ where: { id } })
      expect(row.deletedAt).not.toBeNull()
    }
  })

  it('keeps descendants out of name search once the parent is deleted', async () => {
    const t = await tree()
    const legal = await prisma.node.findUniqueOrThrow({
      where: { id: t.legal.id },
    })
    await del.remove(t.ctx, legal)
    const rows = await prisma.node.findMany({
      where: { roomId: t.roomId, name: { contains: 'MSA' }, deletedAt: null },
    })
    expect(rows).toEqual([])
  })

  it('makes a guest inside the deleted folder receive GONE', async () => {
    const t = await tree()
    const token = 'gone-token'
    await createShare({
      nodeId: t.contracts.id,
      mode: 'PUBLIC_LINK',
      createdById: t.owner.id,
      tokenHash: hashShareToken(token),
    })
    const legal = await prisma.node.findUniqueOrThrow({
      where: { id: t.legal.id },
    })
    await del.remove(t.ctx, legal)

    await expect(
      resolver.forNode({ nodeId: t.msa.id, shareToken: token }),
    ).rejects.toMatchObject({ code: 'GONE' })
  })

  it('frees the name for reuse after deletion', async () => {
    const t = await tree()
    const nda = await prisma.node.findUniqueOrThrow({
      where: { id: t.nda.id },
    })
    await del.remove(t.ctx, nda)
    const legal = await prisma.node.findUniqueOrThrow({
      where: { id: t.legal.id },
    })
    await expect(
      createFile({ ...legal, roomId: t.roomId }, 'NDA.pdf', t.owner.id),
    ).resolves.toBeDefined()
  })

  it('refuses to delete the room root through the node endpoint', async () => {
    const t = await tree()
    const root = await prisma.node.findUniqueOrThrow({
      where: { id: t.rootId },
    })
    await expect(del.remove(t.ctx, root)).rejects.toMatchObject({
      code: 'INVALID_TARGET',
    })
  })

  /**
   * Every HTTP-reachable path resolves `node` via `AccessGuard`, which already proves
   * `node` belongs to `ctx`'s room — so an e2e test can never construct a mismatched
   * pair. This calls the service directly with a `ctx` from room A and a `node` from
   * room B, the way a future caller with a bug could, and proves the `roomId` filter
   * inside the SQL — not the guard — is what stops the cross-room read/write.
   */
  it('cross-scope: preview of a node from another room counts nothing', async () => {
    const a = await tree()
    const b = await tree()
    // A live share on the exact node id room B holds — id is globally unique, so
    // matching this share by id alone (without also requiring roomId = ctx.roomId)
    // would leak its existence to ctx A. This is what makes the roomId condition in
    // the share-count query load-bearing rather than redundant with `n.id = node.id`.
    await createShare({
      nodeId: b.legal.id,
      mode: 'PUBLIC_LINK',
      createdById: b.owner.id,
      tokenHash: hashShareToken('cross-room-share'),
    })

    await expect(del.preview(a.ctx, b.legal)).resolves.toMatchObject({
      folders: 0,
      files: 0,
      bytes: 0,
      activeShares: 0,
    })
  })

  it('cross-scope: remove of a node from another room deletes nothing', async () => {
    const a = await tree()
    const b = await tree()

    const result = await del.remove(a.ctx, b.legal)
    expect(result.deletedNodes).toBe(0)

    for (const id of [b.legal.id, b.contracts.id, b.msa.id, b.nda.id]) {
      const row = await prisma.node.findUniqueOrThrow({ where: { id } })
      expect(row.deletedAt).toBeNull()
    }
  })
})
