import type { ExecutionContext } from '@nestjs/common'
import { AccessGuard } from './access.guard'
import { DomainError } from '../common/errors'
import type { AccessContext } from './access-context'
import type { NodeRow } from './access.resolver'

type FakeReq = {
  headers: Record<string, string | string[] | undefined>
  params: Record<string, string | undefined>
  query: Record<string, unknown>
  cookies?: Record<string, string | undefined>
  access?: AccessContext
  accessNode?: NodeRow
}

function execCtxFor(req: FakeReq): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
  } as never
}

const node = { id: 'n1' } as never as NodeRow

const viewerCtx = (roomId: string): AccessContext => ({
  role: 'VIEWER',
  roomId,
  scopeRootId: 'scope-root',
  scopePath: '/scope-root/',
})

const ownerCtx = (roomId: string): AccessContext => ({
  role: 'OWNER',
  roomId,
  scopeRootId: 'root',
  scopePath: '/root/',
})

function makeGuard(opts: {
  forNode?: jest.Mock
  forRoom?: jest.Mock
  requireOwner?: boolean
  jwtVerify?: jest.Mock
  findUser?: jest.Mock
}) {
  const resolver = {
    forNode: opts.forNode ?? jest.fn(),
    forRoom: opts.forRoom ?? jest.fn(),
  } as never
  const reflector = {
    get: jest.fn().mockReturnValue(opts.requireOwner ?? false),
  } as never
  const jwt = { verify: opts.jwtVerify ?? jest.fn() } as never
  const config = { get: jest.fn().mockReturnValue('secret') } as never
  const prisma = { user: { findUnique: opts.findUser ?? jest.fn() } } as never
  return new AccessGuard(resolver, reflector, jwt, config, prisma)
}

describe('AccessGuard.canActivate', () => {
  it('rejects with INVALID_CREDENTIALS when neither a session nor a share token is present', async () => {
    const guard = makeGuard({})
    const req: FakeReq = { headers: {}, params: {}, query: {} }
    await expect(guard.canActivate(execCtxFor(req))).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    })
  })

  it('prefers params.id over params.nodeId, query.parentId and params.roomId', async () => {
    const forNode = jest
      .fn()
      .mockResolvedValue({ ctx: viewerCtx('room1'), node })
    const guard = makeGuard({ forNode })
    const req: FakeReq = {
      headers: { 'x-share-token': 'tok' },
      params: { id: 'nodeA', nodeId: 'nodeB', roomId: 'room1' },
      query: { parentId: 'nodeC' },
    }
    await guard.canActivate(execCtxFor(req))
    expect(forNode).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'nodeA' }),
    )
  })

  it('falls back to params.nodeId when params.id is absent', async () => {
    const forNode = jest
      .fn()
      .mockResolvedValue({ ctx: viewerCtx('room1'), node })
    const guard = makeGuard({ forNode })
    const req: FakeReq = {
      headers: { 'x-share-token': 'tok' },
      params: { nodeId: 'nodeB' },
      query: {},
    }
    await guard.canActivate(execCtxFor(req))
    expect(forNode).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'nodeB' }),
    )
  })

  it('falls back to query.parentId when no route param names a node', async () => {
    const forNode = jest
      .fn()
      .mockResolvedValue({ ctx: viewerCtx('room1'), node })
    const guard = makeGuard({ forNode })
    const req: FakeReq = {
      headers: { 'x-share-token': 'tok' },
      params: {},
      query: { parentId: 'nodeC' },
    }
    await guard.canActivate(execCtxFor(req))
    expect(forNode).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'nodeC' }),
    )
  })

  it('treats a repeated query.parentId (string[]) as absent instead of crashing, and falls back to roomId', async () => {
    const forRoom = jest
      .fn()
      .mockResolvedValue({ ctx: ownerCtx('room1'), node })
    const forNode = jest.fn()
    const guard = makeGuard({ forNode, forRoom })
    const req: FakeReq = {
      headers: { 'x-share-token': 'tok' },
      params: { roomId: 'room1' },
      query: { parentId: ['a', 'b'] },
    }
    await guard.canActivate(execCtxFor(req))
    expect(forNode).not.toHaveBeenCalled()
    expect(forRoom).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'room1' }),
    )
  })

  it('returns NOT_FOUND, not a raw 500, when no id source resolves to anything', async () => {
    const guard = makeGuard({})
    const req: FakeReq = {
      headers: { 'x-share-token': 'tok' },
      params: {},
      query: {},
    }
    const result = guard.canActivate(execCtxFor(req))
    await expect(result).rejects.toBeInstanceOf(DomainError)
    await expect(result).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects with NOT_FOUND when the resolved node belongs to a different room than params.roomId names', async () => {
    // nodeId resolves via query.parentId to a node the caller legitimately owns, but
    // in a *different* room than the one named in the URL — the cross-tenant hazard.
    const forNode = jest
      .fn()
      .mockResolvedValue({ ctx: ownerCtx('my-room'), node })
    const guard = makeGuard({ forNode })
    const req: FakeReq = {
      headers: { 'x-share-token': 'tok' },
      params: { roomId: 'victim-room' },
      query: { parentId: 'my-node' },
    }
    await expect(guard.canActivate(execCtxFor(req))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('rejects a VIEWER on an owner-only route with FORBIDDEN_ROLE, not NOT_FOUND', async () => {
    const forNode = jest
      .fn()
      .mockResolvedValue({ ctx: viewerCtx('room1'), node })
    const guard = makeGuard({ forNode, requireOwner: true })
    const req: FakeReq = {
      headers: { 'x-share-token': 'tok' },
      params: { id: 'n1' },
      query: {},
    }
    await expect(guard.canActivate(execCtxFor(req))).rejects.toMatchObject({
      code: 'FORBIDDEN_ROLE',
    })
  })

  it('lets an OWNER through an owner-only route and attaches ctx/node to the request', async () => {
    const ctx = ownerCtx('room1')
    const forNode = jest.fn().mockResolvedValue({ ctx, node })
    const guard = makeGuard({ forNode, requireOwner: true })
    const req: FakeReq = {
      headers: { 'x-share-token': 'tok' },
      params: { id: 'n1' },
      query: {},
    }
    await expect(guard.canActivate(execCtxFor(req))).resolves.toBe(true)
    expect(req.access).toBe(ctx)
    expect(req.accessNode).toBe(node)
  })

  it('resolves the user from an Authorization: Bearer header and forwards it to the resolver', async () => {
    const forNode = jest
      .fn()
      .mockResolvedValue({ ctx: viewerCtx('room1'), node })
    const jwtVerify = jest.fn().mockReturnValue({ sub: 'u1' })
    const findUser = jest
      .fn()
      .mockResolvedValue({ id: 'u1', email: 'a@b.io', name: 'A' })
    const guard = makeGuard({ forNode, jwtVerify, findUser })
    const req: FakeReq = {
      headers: { authorization: 'Bearer good-token' },
      params: { id: 'n1' },
      query: {},
    }
    await guard.canActivate(execCtxFor(req))
    expect(jwtVerify).toHaveBeenCalledWith(
      'good-token',
      expect.objectContaining({ algorithms: ['HS256'] }),
    )
    expect(forNode).toHaveBeenCalledWith(
      expect.objectContaining({
        user: { id: 'u1', email: 'a@b.io', name: 'A' },
      }),
    )
  })

  it('falls back to the access_token cookie when there is no Authorization header', async () => {
    const forNode = jest
      .fn()
      .mockResolvedValue({ ctx: viewerCtx('room1'), node })
    const jwtVerify = jest.fn().mockReturnValue({ sub: 'u1' })
    const findUser = jest
      .fn()
      .mockResolvedValue({ id: 'u1', email: 'a@b.io', name: 'A' })
    const guard = makeGuard({ forNode, jwtVerify, findUser })
    const req: FakeReq = {
      headers: {},
      params: { id: 'n1' },
      query: {},
      cookies: { access_token: 'cookie-token' },
    }
    await guard.canActivate(execCtxFor(req))
    expect(jwtVerify).toHaveBeenCalledWith(
      'cookie-token',
      expect.objectContaining({ algorithms: ['HS256'] }),
    )
  })

  it('treats a JWT that fails verification as no user, not as a thrown error, and still admits a share token', async () => {
    const forNode = jest
      .fn()
      .mockResolvedValue({ ctx: viewerCtx('room1'), node })
    const jwtVerify = jest.fn().mockImplementation(() => {
      throw new Error('bad signature')
    })
    const guard = makeGuard({ forNode, jwtVerify })
    const req: FakeReq = {
      headers: {
        authorization: 'Bearer garbage',
        'x-share-token': 'tok',
      },
      params: { id: 'n1' },
      query: {},
    }
    await guard.canActivate(execCtxFor(req))
    expect(forNode).toHaveBeenCalledWith(
      expect.objectContaining({ user: undefined, shareToken: 'tok' }),
    )
  })
})
