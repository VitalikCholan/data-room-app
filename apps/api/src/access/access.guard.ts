import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import { AppEnv } from '../config/env'
import { PrismaService } from '../prisma/prisma.service'
import { DomainError, notFound } from '../common/errors'
import { AccessResolver, NodeRow } from './access.resolver'
import { AccessContext } from './access-context'

export const REQUIRE_OWNER = 'require_owner'
/** Marks a route as a mutation: a VIEWER reaching it gets 403, not 404, because existence is already known. */
export const RequireOwner = () => SetMetadata(REQUIRE_OWNER, true)

type RequestWithAccess = Request & {
  access?: AccessContext
  accessNode?: NodeRow
}

/**
 * Express parses a repeated query key (`?parentId=a&parentId=b`) to `string[]`, and a
 * repeated header the same way — neither is a single id. Casting either straight to
 * `string | undefined` (the previous shape of this code) is a lie the compiler can't
 * catch: at runtime Prisma receives an array where it expects a scalar and throws a
 * `PrismaClientValidationError`, which `PrismaExceptionFilter` does not handle,
 * turning a malformed request into an unhandled 500. Accepting only an actual
 * non-empty string closes that off — every other shape falls through as "absent".
 */
const asId = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined

export const Access = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): AccessContext =>
    ctx.switchToHttp().getRequest<RequestWithAccess>().access as AccessContext,
)

export const AccessNode = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): NodeRow =>
    ctx.switchToHttp().getRequest<RequestWithAccess>().accessNode as NodeRow,
)

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly resolver: AccessResolver,
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    const req = execCtx.switchToHttp().getRequest<RequestWithAccess>()
    const shareToken = asId(req.headers['x-share-token'])
    const user = await this.userFromRequest(req)

    if (!user && !shareToken) {
      throw new DomainError(
        'INVALID_CREDENTIALS',
        'Sign in or open a share link',
      )
    }

    // Precedence matters. A viewer scoped to a subfolder holds no grant on the room
    // root, so resolving by roomId first would 404 them out of their own share.
    // Node id in the route wins, then an explicit parentId, then the room root.
    const nodeId =
      asId(req.params.id) ?? asId(req.params.nodeId) ?? asId(req.query.parentId)
    const roomId = asId(req.params.roomId)

    let resolved: { ctx: AccessContext; node: NodeRow }
    if (nodeId) {
      resolved = await this.resolver.forNode({ nodeId, user, shareToken })
    } else {
      // No node-shaped id anywhere in the request. Previously this fell through to
      // `forRoom({ roomId: roomId! })` on blind faith; a request with none of
      // params.id/nodeId/query.parentId/params.roomId turned `roomId!` into
      // `forRoom({ roomId: undefined })`, an unhandled 500 rather than a 404.
      if (!roomId) throw notFound()
      resolved = await this.resolver.forRoom({ roomId, user, shareToken })
    }

    // A node id can arrive via `query.parentId` — caller-chosen, unrelated to the
    // `:roomId` in the route. Nothing reads `params.roomId` today, but the moment a
    // later route builds a query from `@Param('roomId')` instead of `ctx.roomId`,
    // a resolved node from a different room than the one named in the URL becomes a
    // live cross-tenant read. Reject the mismatch here, once, for every future route.
    if (roomId && resolved.ctx.roomId !== roomId) throw notFound()

    if (
      this.reflector.get<boolean>(REQUIRE_OWNER, execCtx.getHandler()) &&
      resolved.ctx.role !== 'OWNER'
    ) {
      throw new DomainError('FORBIDDEN_ROLE', 'Read-only access')
    }

    req.access = resolved.ctx
    req.accessNode = resolved.node
    return true
  }

  /**
   * Deliberately independent of `JwtAuthGuard`/`JwtStrategy`: this guard must accept an
   * *absent* user (a public-link viewer signs in to nothing) rather than reject the
   * request, so it cannot delegate to a guard whose contract is "authenticate or 401".
   * The verification itself still mirrors JwtStrategy exactly — same extraction order,
   * same pinned algorithm — so a token valid there is valid here and vice versa.
   */
  private async userFromRequest(req: Request) {
    const header = req.headers.authorization
    const raw = header?.startsWith('Bearer ')
      ? header.slice(7)
      : (req.cookies?.access_token as string | undefined)
    if (!raw) return undefined
    try {
      const { sub } = this.jwt.verify<{ sub: string }>(raw, {
        secret: this.config.get('JWT_SECRET', { infer: true }),
        algorithms: ['HS256'],
      })
      const user = await this.prisma.user.findUnique({ where: { id: sub } })
      return user
        ? { id: user.id, email: user.email, name: user.name }
        : undefined
    } catch {
      return undefined
    }
  }
}
