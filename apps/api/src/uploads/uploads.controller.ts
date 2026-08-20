import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import { Access, AccessGuard, RequireOwner } from '../access/access.guard'
import type { AccessContext } from '../access/access-context'
import { UploadsService } from './uploads.service'
import { ConfirmUploadDto, PresignUploadDto } from './dto/uploads.dto'

@ApiTags('uploads')
@ApiBearerAuth('access-token')
@Controller()
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('rooms/:roomId/uploads/presign')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({
    summary: 'Reserve a file row and return a presigned PUT url',
  })
  @ApiResponse({
    status: 409,
    description: 'NAME_CONFLICT — resend with onConflict to resolve',
  })
  @ApiResponse({ status: 413, description: 'Declared size exceeds 50 MB' })
  @ApiResponse({
    status: 415,
    description: 'Only application/pdf is accepted',
  })
  presign(@Access() ctx: AccessContext, @Body() dto: PresignUploadDto) {
    return this.uploads.presign(ctx, dto)
  }

  @Post('uploads/:nodeId/confirm')
  @UseGuards(AccessGuard)
  @RequireOwner()
  @ApiOperation({
    summary: 'Verify the uploaded object and activate the file',
  })
  @ApiResponse({
    status: 409,
    description: 'UPLOAD_NOT_FOUND — the object is not in storage yet',
  })
  @ApiResponse({
    status: 413,
    description: 'Stored object exceeds 50 MB; it has been deleted',
  })
  @ApiResponse({
    status: 415,
    description: 'Stored object is not a PDF; it has been deleted',
  })
  @ApiResponse({
    status: 422,
    description:
      'EMPTY_UPLOAD — the stored object is zero bytes; it has been deleted',
  })
  confirm(
    @Access() ctx: AccessContext,
    @Param('nodeId') nodeId: string,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.uploads.confirm(ctx, nodeId, dto.versionId)
  }
}
