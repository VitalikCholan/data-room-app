import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger'
import { Access, AccessGuard } from '../access/access.guard'
import type { AccessContext } from '../access/access-context'
import { SearchService } from './search.service'
import { SearchQueryDto } from './dto/search.dto'

@ApiTags('search')
@ApiBearerAuth('access-token')
@ApiSecurity('share-token')
@Controller('rooms/:roomId/search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @UseGuards(AccessGuard)
  @ApiOperation({
    summary: 'Find folders and files by name inside the caller scope',
  })
  @ApiResponse({ status: 404, description: 'Not found or no access' })
  @ApiResponse({
    status: 422,
    description: 'Query shorter than two characters, or a malformed cursor',
  })
  find(@Access() ctx: AccessContext, @Query() query: SearchQueryDto) {
    // `parentId` is not passed on: AccessGuard already resolved it into ctx (that is
    // how a viewer's scope narrows to the shared subtree). Reading it again here would
    // be a second, unauthorized interpretation of the same parameter.
    return this.search.byName(ctx, query.q, {
      cursor: query.cursor,
      limit: query.limit ?? 25,
    })
  }
}
