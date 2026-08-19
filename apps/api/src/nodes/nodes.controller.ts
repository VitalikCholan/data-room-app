import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
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
import { NodesService } from './nodes.service'
import {
  CreateFolderDto,
  ListNodesQueryDto,
  RenameNodeDto,
} from './dto/nodes.dto'
import { PrismaService } from '../prisma/prisma.service'
import { notFound } from '../common/errors'

@ApiTags('nodes')
@ApiBearerAuth('access-token')
@ApiSecurity('share-token')
@Controller()
export class NodesController {
  constructor(
    private readonly nodes: NodesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('rooms/:roomId/nodes')
  @UseGuards(AccessGuard)
  @ApiOperation({
    summary: 'List a folder: children, breadcrumbs and the caller role',
  })
  @ApiResponse({ status: 404, description: 'Not found or no access' })
  @ApiResponse({
    status: 410,
    description: 'The folder or an ancestor was deleted by the owner',
  })
  @ApiResponse({ status: 422, description: 'Malformed cursor' })
  list(
    @Access() ctx: AccessContext,
    @AccessNode() node: NodeRow,
    @Query() query: ListNodesQueryDto,
  ) {
    return this.nodes.list(ctx, node, query)
  }

  @Post('rooms/:roomId/folders')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({ summary: 'Create a folder' })
  @ApiResponse({ status: 403, description: 'Read-only access' })
  @ApiResponse({
    status: 409,
    description: 'A folder or file with this name already exists here',
  })
  async createFolder(
    @Access() ctx: AccessContext,
    @Body() dto: CreateFolderDto,
  ) {
    const parent = (await this.prisma.node.findFirst({
      where: { id: dto.parentId, roomId: ctx.roomId, deletedAt: null },
    })) as NodeRow | null
    if (!parent) throw notFound()
    return this.nodes.createFolder(ctx, parent, dto.name)
  }

  @Patch('nodes/:id')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({ summary: 'Rename a folder or file' })
  @ApiResponse({ status: 403, description: 'Read-only access' })
  @ApiResponse({
    status: 409,
    description: 'That name is taken in this folder',
  })
  rename(
    @Access() ctx: AccessContext,
    @AccessNode() node: NodeRow,
    @Body() dto: RenameNodeDto,
  ) {
    return this.nodes.rename(ctx, node, dto.name)
  }
}
