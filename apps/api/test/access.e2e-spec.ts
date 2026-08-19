import { Test, TestingModule } from '@nestjs/testing'
import { AppModule } from '../src/app.module'
import { AccessResolver } from '../src/access/access.resolver'
import { DomainError } from '../src/common/errors'
import { hashShareToken } from '../src/access/share-token'
import {
  createFile,
  createFolder,
  createRoom,
  createShare,
  createUser,
  prisma,
} from './factories'
import { childPath } from '../src/nodes/node-path'
import { truncateDb } from './support/truncate-db'

describe('AccessResolver', () => {
  let resolver: AccessResolver
  let mod: TestingModule

  beforeAll(async () => {
    mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    resolver = mod.get(AccessResolver)
  })
  afterAll(async () => {
    await truncateDb(prisma)
    // Closes the testing module's own DI-managed PrismaService too (onModuleDestroy ->
    // $disconnect()) — without this, only the factories' standalone `prisma` client is
    // disconnected and the module's own pg pool is left open, which is what produced
    // Jest's "did not exit one second after the test run" warning during development.
    await mod.close()
    await prisma.$disconnect()
  })

  async function fixture() {
    const owner = await createUser()
    const guest = await createUser()
    const { roomId, rootId, root } = await createRoom(owner.id)
    const legal = await createFolder({ ...root, roomId }, 'Legal', owner.id)
    const contracts = await createFolder(legal, 'Contracts', owner.id)
    const msa = await createFile(contracts, 'MSA.pdf', owner.id)
    const financials = await createFolder(
      { ...root, roomId },
      'Financials',
      owner.id,
    )
    return {
      owner,
      guest,
      roomId,
      rootId,
      root,
      legal,
      contracts,
      msa,
      financials,
    }
  }

  const authUser = (u: { id: string; email: string; name: string }) => ({
    id: u.id,
    email: u.email,
    name: u.name,
  })

  it('gives the owner OWNER role scoped to the room root', async () => {
    const f = await fixture()
    const { ctx } = await resolver.forNode({
      nodeId: f.msa.id,
      user: authUser(f.owner),
    })
    expect(ctx.role).toBe('OWNER')
    expect(ctx.scopeRootId).toBe(f.rootId)
  })

  it('returns 404, not 403, for a stranger — existence must not leak', async () => {
    const f = await fixture()
    await expect(
      resolver.forNode({ nodeId: f.msa.id, user: authUser(f.guest) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('grants VIEWER through a USER share on an ancestor, scoped to that ancestor', async () => {
    const f = await fixture()
    await createShare({
      nodeId: f.legal.id,
      mode: 'USER',
      createdById: f.owner.id,
      granteeEmail: f.guest.email,
    })

    const { ctx } = await resolver.forNode({
      nodeId: f.msa.id,
      user: authUser(f.guest),
    })
    expect(ctx.role).toBe('VIEWER')
    expect(ctx.scopeRootId).toBe(f.legal.id)
    expect(ctx.scopePath).toBe(childPath(f.legal))
  })

  it('does not let a scoped viewer reach a sibling subtree', async () => {
    const f = await fixture()
    await createShare({
      nodeId: f.legal.id,
      mode: 'USER',
      createdById: f.owner.id,
      granteeEmail: f.guest.email,
    })
    await expect(
      resolver.forNode({ nodeId: f.financials.id, user: authUser(f.guest) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('does not let a scoped viewer reach the room root above the share', async () => {
    const f = await fixture()
    await createShare({
      nodeId: f.legal.id,
      mode: 'USER',
      createdById: f.owner.id,
      granteeEmail: f.guest.email,
    })
    await expect(
      resolver.forNode({ nodeId: f.rootId, user: authUser(f.guest) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('grants VIEWER through a public link with no signed-in user', async () => {
    const f = await fixture()
    const token = 'public-token-fixture'
    await createShare({
      nodeId: f.contracts.id,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })

    const { ctx } = await resolver.forNode({
      nodeId: f.msa.id,
      shareToken: token,
    })
    expect(ctx.role).toBe('VIEWER')
    expect(ctx.scopeRootId).toBe(f.contracts.id)
  })

  it('rejects a revoked share', async () => {
    const f = await fixture()
    const token = 'revoked-token-fixture'
    const share = await createShare({
      nodeId: f.legal.id,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })
    await prisma.share.update({
      where: { id: share.id },
      data: { revokedAt: new Date() },
    })
    await expect(
      resolver.forNode({ nodeId: f.msa.id, shareToken: token }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns GONE when an ancestor was deleted under a guest', async () => {
    const f = await fixture()
    await createShare({
      nodeId: f.legal.id,
      mode: 'USER',
      createdById: f.owner.id,
      granteeEmail: f.guest.email,
    })
    await prisma.node.update({
      where: { id: f.contracts.id },
      data: { deletedAt: new Date() },
    })
    await expect(
      resolver.forNode({ nodeId: f.msa.id, user: authUser(f.guest) }),
    ).rejects.toMatchObject({ code: 'GONE' })
  })

  it('returns GONE for the owner too when the node itself is deleted', async () => {
    const f = await fixture()
    await prisma.node.update({
      where: { id: f.msa.id },
      data: { deletedAt: new Date() },
    })
    await expect(
      resolver.forNode({ nodeId: f.msa.id, user: authUser(f.owner) }),
    ).rejects.toMatchObject({ code: 'GONE' })
  })

  it('prefers the deepest grant when two shares overlap', async () => {
    const f = await fixture()
    await createShare({
      nodeId: f.rootId,
      mode: 'USER',
      createdById: f.owner.id,
      granteeEmail: f.guest.email,
    })
    await createShare({
      nodeId: f.contracts.id,
      mode: 'USER',
      createdById: f.owner.id,
      granteeEmail: f.guest.email,
    })
    const { ctx } = await resolver.forNode({
      nodeId: f.msa.id,
      user: authUser(f.guest),
    })
    expect(ctx.scopeRootId).toBe(f.contracts.id)
  })

  it('throws NOT_FOUND for an unknown node id', async () => {
    await expect(
      resolver.forNode({ nodeId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toBeInstanceOf(DomainError)
  })
})
