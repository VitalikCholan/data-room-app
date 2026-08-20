import { Controller, Get, Param } from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { SharesService } from './shares.service'

@ApiTags('shares')
@Controller('shared')
export class PublicShareController {
  constructor(private readonly shares: SharesService) {}

  @Get(':token')
  @ApiOperation({
    summary:
      'Resolve a public link into its target — no authentication required',
  })
  @ApiResponse({ status: 404, description: 'No such link' })
  @ApiResponse({
    status: 410,
    description: 'Link revoked, or the item was deleted',
  })
  resolve(@Param('token') token: string) {
    return this.shares.resolveToken(token)
  }
}
