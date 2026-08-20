import { INestApplication } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { configureApp } from '../src/bootstrap'
import { hashShareToken } from '../src/access/share-token'
import type { AccessContext } from '../src/access/access-context'
import { childPath } from '../src/nodes/node-path'
import { SearchService } from '../src/search/search.service'
import {
  createFile,
  createFolder,
  createRoom,
  createShare,
  createUser,
  prisma,
} from './factories'
import { truncateDb } from './support/truncate-db'

type LoginBody = { accessToken: string }
type Hit = { id: string; name: string; type: string; parentId: string | null }
type SearchBody = { items: Hit[]; nextCursor: string | null }

describe('search', () => {
  let mod: TestingModule
  let app: INestApplication
  let search: SearchService

  beforeAll(async () => {
    mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = mod.createNestApplication()
    configureApp(app)
    await app.init()
    search = mod.get(SearchService)
  })
  afterAll(async () => {
    await truncateDb(prisma)
    await app.close()
    await prisma.$disconnect()
  })

  async function fixture() {
    const owner = await createUser()
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: owner.email, password: owner.password })
    const { accessToken } = loginRes.body as LoginBody
    const { roomId, rootId, root } = await createRoom(owner.id)
    const legal = await createFolder({ ...root, roomId }, 'Legal', owner.id)
    const financials = await createFolder(
      { ...root, roomId },
      'Financials',
      owner.id,
    )
    await createFile(legal, 'Master Services Agreement.pdf', owner.id)
    await createFile(financials, 'FY23 Audit.pdf', owner.id)
    await createFile(financials, 'FY24 Audit.pdf', owner.id)
    return {
      owner,
      roomId,
      rootId,
      root,
      legal,
      financials,
      auth: { Authorization: `Bearer ${accessToken}` },
    }
  }

  it('finds files across the whole room by substring, case-insensitively', async () => {
    const f = await fixture()
    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/search?q=audit`)
      .set(f.auth)
      .expect(200)
    expect((res.body as SearchBody).items.map((i) => i.name).sort()).toEqual([
      'FY23 Audit.pdf',
      'FY24 Audit.pdf',
    ])
  })

  it('returns the containing folder for context', async () => {
    const f = await fixture()
    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/search?q=Master`)
      .set(f.auth)
      .expect(200)
    expect((res.body as SearchBody).items[0]).toMatchObject({
      parentId: f.legal.id,
      parentName: 'Legal',
      type: 'FILE',
    })
  })

  it('matches folders as well as files', async () => {
    const f = await fixture()
    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/search?q=financ`)
      .set(f.auth)
      .expect(200)
    expect((res.body as SearchBody).items.map((i) => i.name)).toEqual([
      'Financials',
    ])
  })

  it('never returns results outside a viewer scope', async () => {
    const f = await fixture()
    const token = 'search-scope-token'
    await createShare({
      nodeId: f.legal.id,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })

    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/search?q=audit&parentId=${f.legal.id}`)
      .set({ 'X-Share-Token': token })
      .expect(200)
    expect((res.body as SearchBody).items).toEqual([])

    const inScope = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/search?q=master&parentId=${f.legal.id}`)
      .set({ 'X-Share-Token': token })
      .expect(200)
    expect((inScope.body as SearchBody).items).toHaveLength(1)
  })

  it('excludes the scope root itself from hits', async () => {
    const f = await fixture()
    const token = 'scope-root-token'
    await createShare({
      nodeId: f.legal.id,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })
    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/search?q=legal&parentId=${f.legal.id}`)
      .set({ 'X-Share-Token': token })
      .expect(200)
    expect((res.body as SearchBody).items).toEqual([])
  })

  it('excludes deleted and PENDING nodes', async () => {
    const f = await fixture()
    const deleted = await createFile(f.financials, 'FY22 Audit.pdf', f.owner.id)
    await prisma.node.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    })
    await prisma.node.create({
      data: {
        roomId: f.roomId,
        parentId: f.financials.id,
        type: 'FILE',
        name: 'FY21 Audit.pdf',
        path: `/${f.rootId}/${f.financials.id}/`,
        status: 'PENDING',
        createdById: f.owner.id,
      },
    })

    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/search?q=audit`)
      .set(f.auth)
      .expect(200)
    expect((res.body as SearchBody).items.map((i) => i.name).sort()).toEqual([
      'FY23 Audit.pdf',
      'FY24 Audit.pdf',
    ])
  })

  it('rejects a query shorter than two characters with 422', async () => {
    const f = await fixture()
    await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/search?q=a`)
      .set(f.auth)
      .expect(422)
  })

  it('treats a percent sign as a literal, not a wildcard', async () => {
    const f = await fixture()
    await createFile(f.financials, 'Margin 20% FY24.pdf', f.owner.id)
    // The decoy is what makes this test discriminating: unescaped, "20%" becomes
    // "%20%%" — "anything containing 20" — and would drag this file in too.
    await createFile(f.financials, 'Budget 2026 draft.pdf', f.owner.id)
    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/search?q=${encodeURIComponent('20%')}`)
      .set(f.auth)
      .expect(200)
    expect((res.body as SearchBody).items.map((i) => i.name)).toEqual([
      'Margin 20% FY24.pdf',
    ])
  })

  it('treats an underscore as a literal, not a single-character wildcard', async () => {
    const f = await fixture()
    await createFile(f.financials, 'FY24_final.pdf', f.owner.id)
    // Unescaped, "4_f" becomes "%4_f%" where _ matches any single character — which
    // would also match the space in this decoy.
    await createFile(f.financials, 'FY24 final.pdf', f.owner.id)
    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/search?q=${encodeURIComponent('4_f')}`)
      .set(f.auth)
      .expect(200)
    expect((res.body as SearchBody).items.map((i) => i.name)).toEqual([
      'FY24_final.pdf',
    ])
  })

  it('paginates results', async () => {
    const f = await fixture()
    const first = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/search?q=audit&limit=1`)
      .set(f.auth)
      .expect(200)
    const firstBody = first.body as SearchBody
    expect(firstBody.items).toHaveLength(1)
    expect(firstBody.nextCursor).toBeTruthy()

    const second = await request(app.getHttpServer())
      .get(
        `/rooms/${f.roomId}/search?q=audit&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      )
      .set(f.auth)
      .expect(200)
    const secondBody = second.body as SearchBody
    expect(secondBody.items[0].name).not.toBe(firstBody.items[0].name)
    expect(secondBody.nextCursor).toBeNull()
  })

  /**
   * Over HTTP the guard hands the service a ctx it derived itself, so an HTTP-only
   * test can never construct a mismatched (ctx, query) pair — and a guard that
   * short-circuited first would make those assertions vacuous. These call the service
   * the way a future caller with a bug would: a ctx scoped to one subtree, a query
   * that would otherwise sweep the whole room. Same reasoning as
   * nodes-repository.e2e-spec.ts. Mutation-checked: deleting `withinScope(ctx)` (or
   * the scope-root exclusion) from the query fails these, and only these.
   */
  describe('SearchService — scope enforced in SQL, not by the guard', () => {
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

    it('finds nothing under Financials/ when ctx is scoped to Legal/', async () => {
      const f = await fixture()
      const result = await search.byName(
        legalScopedCtx(f.roomId, f.legal),
        'audit',
        { limit: 25 },
      )
      expect(result.items).toEqual([])
      expect(result.nextCursor).toBeNull()
    })

    it('still finds what is inside the scope', async () => {
      const f = await fixture()
      const result = await search.byName(
        legalScopedCtx(f.roomId, f.legal),
        'master',
        { limit: 25 },
      )
      expect(result.items.map((i) => i.name)).toEqual([
        'Master Services Agreement.pdf',
      ])
    })

    it('excludes the scope root row itself', async () => {
      const f = await fixture()
      const result = await search.byName(
        legalScopedCtx(f.roomId, f.legal),
        'legal',
        { limit: 25 },
      )
      expect(result.items).toEqual([])
    })

    it('finds nothing in another room, even for a matching name', async () => {
      const f = await fixture()
      const stranger = await createUser()
      const other = await createRoom(stranger.id)
      await createFile(
        { ...other.root, roomId: other.roomId },
        'Master Plan.pdf',
        stranger.id,
      )
      const result = await search.byName(
        legalScopedCtx(f.roomId, f.legal),
        'master',
        { limit: 25 },
      )
      expect(result.items.map((i) => i.name)).toEqual([
        'Master Services Agreement.pdf',
      ])
    })
  })
})
