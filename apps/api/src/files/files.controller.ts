import { Controller, Get, Redirect, UseGuards } from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger'
import { Access, AccessGuard, AccessNode } from '../access/access.guard'
import type { AccessContext } from '../access/access-context'
import type { NodeRow } from '../access/access.resolver'
import { FilesService } from './files.service'

@ApiTags('files')
@ApiBearerAuth('access-token')
@ApiSecurity('share-token')
@Controller('nodes')
export class FilesController {
  constructor(private readonly files: FilesService) {}

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
  async content(@Access() ctx: AccessContext, @AccessNode() node: NodeRow) {
    return { url: await this.files.presignedUrlFor(ctx, node), statusCode: 302 }
  }
}
