import { PrismaPg } from '@prisma/adapter-pg'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '../src/generated/prisma/client'

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) })

async function makeRoom() {
  const user = await prisma.user.create({ data: { email: `u-${randomUUID()}@t.io`, name: 'T', passwordHash: 'x' } })
  const roomId = randomUUID()
  const rootId = randomUUID()
  await prisma.dataRoom.create({ data: { id: roomId, ownerId: user.id, name: 'R', rootNodeId: rootId } })
  await prisma.node.create({
    data: { id: rootId, roomId, type: 'FOLDER', name: 'R', path: '/', status: 'ACTIVE', createdById: user.id },
  })
  return { userId: user.id, roomId, rootId }
}

describe('schema constraints', () => {
  afterAll(() => prisma.$disconnect())

  it('rejects two live siblings with the same name', async () => {
    const { userId, roomId, rootId } = await makeRoom()
    const base = { roomId, parentId: rootId, type: 'FOLDER' as const, path: `/${rootId}/`, status: 'ACTIVE' as const, createdById: userId }
    await prisma.node.create({ data: { ...base, name: 'Financials' } })
    await expect(prisma.node.create({ data: { ...base, name: 'Financials' } })).rejects.toMatchObject({ code: 'P2002' })
  })

  it('treats names as case-insensitive for conflicts', async () => {
    const { userId, roomId, rootId } = await makeRoom()
    const base = { roomId, parentId: rootId, type: 'FILE' as const, path: `/${rootId}/`, status: 'ACTIVE' as const, createdById: userId }
    await prisma.node.create({ data: { ...base, name: 'Invoice.pdf' } })
    await expect(prisma.node.create({ data: { ...base, name: 'invoice.pdf' } })).rejects.toMatchObject({ code: 'P2002' })
  })

  it('allows reusing the name of a deleted sibling', async () => {
    const { userId, roomId, rootId } = await makeRoom()
    const base = { roomId, parentId: rootId, type: 'FILE' as const, path: `/${rootId}/`, status: 'ACTIVE' as const, createdById: userId }
    const first = await prisma.node.create({ data: { ...base, name: 'Deck.pdf' } })
    await prisma.node.update({ where: { id: first.id }, data: { deletedAt: new Date() } })
    await expect(prisma.node.create({ data: { ...base, name: 'Deck.pdf' } })).resolves.toBeDefined()
  })

  it('has the three hand-written indexes', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'Node'`
    const names = rows.map((r) => r.indexname)
    expect(names).toEqual(expect.arrayContaining(['node_name_uniq', 'node_path_prefix', 'node_name_trgm']))
  })
})
