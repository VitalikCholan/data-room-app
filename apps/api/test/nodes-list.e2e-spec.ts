import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { configureApp } from '../src/bootstrap'
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

// supertest types `Response.body` as `any`; these give the shapes this suite actually
// reads back so lint's typed rules can verify property access — same pattern as
// rooms.e2e-spec.ts.
type LoginBody = { accessToken: string }
type NodeItem = { id: string; name: string; type: 'FOLDER' | 'FILE' }
type Crumb = { id: string; name: string; type: 'FOLDER' | 'FILE' }
type ListBody = {
  items: NodeItem[]
  nextCursor: string | null
  breadcrumbs: Crumb[]
}

describe('node listing', () => {
  let app: INestApplication

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = mod.createNestApplication()
    configureApp(app)
    await app.init()
  })
  afterAll(async () => {
    await truncateDb(prisma)
    await app.close()
    await prisma.$disconnect()
  })

  async function ownerFixture() {
    const owner = await createUser()
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: owner.email, password: owner.password })
    const { accessToken } = loginRes.body as LoginBody
    const { roomId, rootId, root } = await createRoom(owner.id)
    return {
      owner,
      token: accessToken,
      roomId,
      rootId,
      root: { ...root, roomId },
    }
  }

  it('lists direct children with folders first, then files, both by name', async () => {
    const f = await ownerFixture()
    await createFile(f.root, 'b.pdf', f.owner.id)
    await createFile(f.root, 'a.pdf', f.owner.id)
    await createFolder(f.root, 'Zebra', f.owner.id)
    await createFolder(f.root, 'Alpha', f.owner.id)

    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes`)
      .set({ Authorization: `Bearer ${f.token}` })
      .expect(200)
    const body = res.body as ListBody

    expect(body.items.map((i) => i.name)).toEqual([
      'Alpha',
      'Zebra',
      'a.pdf',
      'b.pdf',
    ])
    expect(body.breadcrumbs).toEqual([
      { id: f.rootId, name: 'Project Titan', type: 'FOLDER' },
    ])
    expect(body.nextCursor).toBeNull()
  })

  // Round-1 fix: the sort key concatenated a fixed '0'/'1' type marker with the sort
  // expression and applied one direction to the whole string. Under a descending
  // mode ('updatedAt', 'size') the marker's own ordering flips too, so files (marker
  // '1') sorted ahead of folders (marker '0') — the opposite of the requirement.
  // This is the test that was missing: the earlier folders-first case only checked
  // the default `sort=name`, where descending is never exercised.
  it('sorts folders before files under every sort mode', async () => {
    const f = await ownerFixture()
    await createFile(f.root, 'big.pdf', f.owner.id, 5000)
    await createFile(f.root, 'small.pdf', f.owner.id, 10)
    await createFolder(f.root, 'Zebra', f.owner.id)
    await createFolder(f.root, 'Alpha', f.owner.id)

    for (const sort of ['name', 'updatedAt', 'size'] as const) {
      const res = await request(app.getHttpServer())
        .get(`/rooms/${f.roomId}/nodes?sort=${sort}`)
        .set({ Authorization: `Bearer ${f.token}` })
        .expect(200)
      const body = res.body as ListBody

      expect(body.items).toHaveLength(4)
      const types = body.items.map((i) => i.type)
      expect(types.indexOf('FILE')).toBeGreaterThan(types.lastIndexOf('FOLDER'))
    }
  })

  it('does not list PENDING uploads', async () => {
    const f = await ownerFixture()
    await createFile(f.root, 'visible.pdf', f.owner.id)
    await prisma.node.create({
      data: {
        roomId: f.roomId,
        parentId: f.rootId,
        type: 'FILE',
        name: 'ghost.pdf',
        path: `/${f.rootId}/`,
        status: 'PENDING',
        createdById: f.owner.id,
      },
    })

    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes`)
      .set({ Authorization: `Bearer ${f.token}` })
      .expect(200)
    expect((res.body as ListBody).items.map((i) => i.name)).toEqual([
      'visible.pdf',
    ])
  })

  it('does not list soft-deleted children', async () => {
    const f = await ownerFixture()
    const gone = await createFile(f.root, 'gone.pdf', f.owner.id)
    await prisma.node.update({
      where: { id: gone.id },
      data: { deletedAt: new Date() },
    })
    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes`)
      .set({ Authorization: `Bearer ${f.token}` })
      .expect(200)
    expect((res.body as ListBody).items).toEqual([])
  })

  it('paginates with a keyset cursor and never repeats or skips an item', async () => {
    const f = await ownerFixture()
    for (let i = 1; i <= 7; i++)
      await createFile(f.root, `f${String(i).padStart(2, '0')}.pdf`, f.owner.id)

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const url = `/rooms/${f.roomId}/nodes?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = await request(app.getHttpServer())
        .get(url)
        .set({ Authorization: `Bearer ${f.token}` })
        .expect(200)
      const body = page.body as ListBody
      seen.push(...body.items.map((i) => i.name))
      cursor = body.nextCursor
    } while (cursor)

    expect(seen).toEqual([
      'f01.pdf',
      'f02.pdf',
      'f03.pdf',
      'f04.pdf',
      'f05.pdf',
      'f06.pdf',
      'f07.pdf',
    ])
    expect(new Set(seen).size).toBe(7)
  })

  // The case above can't exercise the (sort_key, id) tiebreaker: distinct filenames
  // already give every row a distinct sort_key under sort=name, so `sort_key > cursor`
  // alone would paginate correctly even with the id half of the comparison dropped.
  // Identical sizes under sort=size force real ties, so a keyset that compared only on
  // sort_key would stall — every row after the first page compares equal to the
  // cursor's key and satisfies neither `>` nor `<`, so later pages come back empty and
  // items go missing rather than repeating.
  it('paginates by size without skipping rows that tie on the sort key', async () => {
    const f = await ownerFixture()
    for (let i = 1; i <= 5; i++)
      await createFile(f.root, `s${i}.pdf`, f.owner.id, 2048)

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const url = `/rooms/${f.roomId}/nodes?limit=2&sort=size${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = await request(app.getHttpServer())
        .get(url)
        .set({ Authorization: `Bearer ${f.token}` })
        .expect(200)
      const body = page.body as ListBody
      seen.push(...body.items.map((i) => i.name))
      cursor = body.nextCursor
    } while (cursor)

    expect(seen.sort()).toEqual([
      's1.pdf',
      's2.pdf',
      's3.pdf',
      's4.pdf',
      's5.pdf',
    ])
    expect(new Set(seen).size).toBe(5)
  })

  it('rejects a malformed cursor with 422', async () => {
    const f = await ownerFixture()
    await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes?cursor=%%%`)
      .set({ Authorization: `Bearer ${f.token}` })
      .expect(422)
  })

  it('truncates breadcrumbs at the guest scope root', async () => {
    const f = await ownerFixture()
    const legal = await createFolder(f.root, 'Legal', f.owner.id)
    const contracts = await createFolder(legal, 'Contracts', f.owner.id)
    const token = 'crumbs-token'
    await createShare({
      nodeId: legal.id,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })

    const res = await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes?parentId=${contracts.id}`)
      .set({ 'X-Share-Token': token })
      .expect(200)

    expect((res.body as ListBody).breadcrumbs.map((b) => b.name)).toEqual([
      'Legal',
      'Contracts',
    ])
  })

  it('creates a folder and rejects a duplicate name with 409', async () => {
    const f = await ownerFixture()
    await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/folders`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ parentId: f.rootId, name: 'Financials' })
      .expect(201)

    await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/folders`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ parentId: f.rootId, name: 'financials' })
      .expect(409)
  })

  it('rejects a folder name containing a slash with 422', async () => {
    const f = await ownerFixture()
    await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/folders`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ parentId: f.rootId, name: 'a/b' })
      .expect(422)
  })

  it('renames a node', async () => {
    const f = await ownerFixture()
    const file = await createFile(f.root, 'old.pdf', f.owner.id)
    await request(app.getHttpServer())
      .patch(`/nodes/${file.id}`)
      .set({ Authorization: `Bearer ${f.token}` })
      .send({ name: 'new.pdf' })
      .expect(200)
    await expect(
      prisma.node.findUniqueOrThrow({ where: { id: file.id } }),
    ).resolves.toMatchObject({ name: 'new.pdf' })
  })

  it('refuses a rename from a share viewer with 403, not 404', async () => {
    const f = await ownerFixture()
    const file = await createFile(f.root, 'readonly.pdf', f.owner.id)
    const token = 'viewer-token'
    await createShare({
      nodeId: f.rootId,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })

    await request(app.getHttpServer())
      .patch(`/nodes/${file.id}`)
      .set({ 'X-Share-Token': token })
      .send({ name: 'hacked.pdf' })
      .expect(403)
  })

  it('refuses a move from a share viewer with 403, not 404', async () => {
    const f = await ownerFixture()
    const file = await createFile(f.root, 'readonly.pdf', f.owner.id)
    const token = 'move-viewer-token'
    await createShare({
      nodeId: f.rootId,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })

    await request(app.getHttpServer())
      .post(`/nodes/${file.id}/move`)
      .set({ 'X-Share-Token': token })
      .send({ targetParentId: f.rootId })
      .expect(403)
  })

  it('refuses a delete from a share viewer with 403, not 404', async () => {
    const f = await ownerFixture()
    const file = await createFile(f.root, 'readonly.pdf', f.owner.id)
    const token = 'delete-viewer-token'
    await createShare({
      nodeId: f.rootId,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })

    await request(app.getHttpServer())
      .delete(`/nodes/${file.id}`)
      .set({ 'X-Share-Token': token })
      .expect(403)
  })

  it('refuses a deletion preview from a share viewer with 403, not 404', async () => {
    const f = await ownerFixture()
    const file = await createFile(f.root, 'readonly.pdf', f.owner.id)
    const token = 'preview-viewer-token'
    await createShare({
      nodeId: f.rootId,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })

    await request(app.getHttpServer())
      .get(`/nodes/${file.id}/deletion-preview`)
      .set({ 'X-Share-Token': token })
      .expect(403)
  })

  it('does not list a Financials sibling when the caller is scoped to Legal', async () => {
    const f = await ownerFixture()
    const legal = await createFolder(f.root, 'Legal', f.owner.id)
    const financials = await createFolder(f.root, 'Financials', f.owner.id)
    await createFile(financials, 'secret.pdf', f.owner.id)
    const token = 'legal-scope-token'
    await createShare({
      nodeId: legal.id,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })

    await request(app.getHttpServer())
      .get(`/rooms/${f.roomId}/nodes?parentId=${financials.id}`)
      .set({ 'X-Share-Token': token })
      .expect(404)
  })

  it('refuses a Legal-scoped viewer creating a folder under Financials with 404', async () => {
    const f = await ownerFixture()
    const legal = await createFolder(f.root, 'Legal', f.owner.id)
    const financials = await createFolder(f.root, 'Financials', f.owner.id)
    const token = 'legal-create-token'
    await createShare({
      nodeId: legal.id,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })

    await request(app.getHttpServer())
      .post(`/rooms/${f.roomId}/folders`)
      .set({ 'X-Share-Token': token })
      .send({ parentId: financials.id, name: 'NewFolder' })
      .expect(404)
  })

  it('refuses a Legal-scoped viewer renaming a node under Financials with 404', async () => {
    const f = await ownerFixture()
    const legal = await createFolder(f.root, 'Legal', f.owner.id)
    const financials = await createFolder(f.root, 'Financials', f.owner.id)
    const file = await createFile(financials, 'secret.pdf', f.owner.id)
    const token = 'legal-rename-token'
    await createShare({
      nodeId: legal.id,
      mode: 'PUBLIC_LINK',
      createdById: f.owner.id,
      tokenHash: hashShareToken(token),
    })

    await request(app.getHttpServer())
      .patch(`/nodes/${file.id}`)
      .set({ 'X-Share-Token': token })
      .send({ name: 'renamed.pdf' })
      .expect(404)
  })
})
