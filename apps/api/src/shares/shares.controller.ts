import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import {
  Access,
  AccessGuard,
  AccessNode,
  RequireOwner,
} from '../access/access.guard'
import type { AccessContext } from '../access/access-context'
import type { NodeRow } from '../access/access.resolver'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import type { AuthUser } from '../auth/auth.service'
import { SharesService } from './shares.service'
import { CreateShareDto } from './dto/shares.dto'

@ApiTags('shares')
@ApiBearerAuth('access-token')
@Controller()
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  @Post('nodes/:id/shares')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({ summary: 'Share a Data Room, folder or file (read-only)' })
  @ApiResponse({
    status: 201,
    description:
      'For PUBLIC_LINK the raw token is returned once and never again',
  })
  @ApiResponse({ status: 403, description: 'Read-only access' })
  create(
    @Access() ctx: AccessContext,
    @AccessNode() node: NodeRow,
    @Body() dto: CreateShareDto,
  ) {
    return this.shares.create(ctx, node, dto)
  }

  @Get('nodes/:id/shares')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({ summary: 'Shares on this item, including revoked ones' })
  list(@Access() ctx: AccessContext, @AccessNode() node: NodeRow) {
    return this.shares.list(ctx, node)
  }

  // Uses JwtAuthGuard rather than AccessGuard: the route parameter is a share id,
  // not a node id, so ownership is checked by joining share → node → room inside
  // the service.
  @Delete('shares/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Revoke a share' })
  @ApiResponse({
    status: 404,
    description: 'Not found or not owned by the caller',
  })
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.shares.revoke(user.id, id)
  }
}
