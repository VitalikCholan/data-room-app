import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Redirect,
  UseGuards,
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
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
import { FilesService } from './files.service'
import { VersionsService } from './versions.service'

@ApiTags('files')
@ApiBearerAuth('access-token')
@ApiSecurity('share-token')
@Controller('nodes')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly versions: VersionsService,
  ) {}

  @Get(':id/content')
  @UseGuards(AccessGuard)
  @Redirect('', 302)
  @ApiOperation({
    summary: 'Redirect to a 5-minute presigned GET for viewing in the browser',
  })
  @ApiResponse({
    status: 302,
    description: 'Location carries the presigned url',
  })
  @ApiResponse({
    status: 410,
    description:
      'Deleted by the owner, or the stored object no longer matches what was verified at upload',
  })
  // Declared explicitly because Swagger infers a bare @Query() param as required, and
  // the generated client the frontend builds from this contract would then demand a
  // version id on every content fetch.
  @ApiQuery({
    name: 'version',
    required: false,
    description: 'Version id; defaults to the current version',
  })
  async content(
    @Access() ctx: AccessContext,
    @AccessNode() node: NodeRow,
    @Query('version') version?: string,
  ) {
    return {
      url: await this.files.presignedUrlFor(ctx, node, version),
      statusCode: 302,
    }
  }

  @Get(':id/versions')
  @UseGuards(AccessGuard)
  @ApiOperation({ summary: 'Version history, newest first' })
  @ApiResponse({ status: 404, description: 'Not a file, or no access' })
  list(@Access() ctx: AccessContext, @AccessNode() node: NodeRow) {
    return this.versions.list(ctx, node)
  }

  @Post(':id/versions/:versionId/restore')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({
    summary: 'Make an earlier version current, appended as a new version',
  })
  @ApiResponse({ status: 403, description: 'Read-only access' })
  @ApiResponse({ status: 422, description: 'That version is already current' })
  restore(
    @Access() ctx: AccessContext,
    @AccessNode() node: NodeRow,
    @Param('versionId') versionId: string,
  ) {
    return this.versions.restore(ctx, node, versionId)
  }
}
