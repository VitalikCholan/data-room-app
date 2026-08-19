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
import { DomainError } from '../common/errors'
import { AccessResolver, NodeRow } from './access.resolver'
import { AccessContext } from './access-context'

export const REQUIRE_OWNER = 'require_owner'
/** Marks a route as a mutation: a VIEWER reaching it gets 403, not 404, because existence is already known. */
export const RequireOwner = () => SetMetadata(REQUIRE_OWNER, true)

type RequestWithAccess = Request & {
  access?: AccessContext
  accessNode?: NodeRow
}

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
    const shareToken =
      (req.headers['x-share-token'] as string | undefined) ?? undefined
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
    const nodeId = (req.params.id ??
      req.params.nodeId ??
      (req.query.parentId as string | undefined)) as string | undefined
    const roomId = req.params.roomId as string | undefined

    const resolved = nodeId
      ? await this.resolver.forNode({ nodeId, user, shareToken })
      : await this.resolver.forRoom({ roomId: roomId!, user, shareToken })

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
