import { TestingModule, Test } from '@nestjs/testing'
import { randomUUID } from 'node:crypto'
import { AppModule } from '../src/app.module'
import { blobKeyFor, StorageService } from '../src/storage/storage.service'

/** Runs against MinIO from docker-compose, so the presigned signature path is real. */
describe('StorageService', () => {
  let mod: TestingModule
  let storage: StorageService
  const key = blobKeyFor('test-room', randomUUID(), 1)
  const body = Buffer.from('%PDF-1.7\n% test fixture\n')

  beforeAll(async () => {
    mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    storage = mod.get(StorageService)
  })
  afterAll(async () => {
    await mod.close()
  })

  it('returns null from head for an object that does not exist', async () => {
    await expect(storage.head(blobKeyFor('nope', 'nope', 1))).resolves.toBeNull()
  })

  it('accepts a PUT to the presigned url and reports the real size and type', async () => {
    const { url, expiresAt } = await storage.presignPut(key, 'application/pdf')
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now())

    const put = await fetch(url, {
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/pdf' },
    })
    expect(put.ok).toBe(true)

    await expect(storage.head(key)).resolves.toEqual({
      contentLength: body.byteLength,
      contentType: 'application/pdf',
    })
  })

  it('serves the bytes back through a presigned GET', async () => {
    const url = await storage.presignGet(key, {
      filename: 'fixture.pdf',
      inline: true,
    })
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(body)
  })

  it('removes an object', async () => {
    await storage.remove(key)
    await expect(storage.head(key)).resolves.toBeNull()
  })
})
