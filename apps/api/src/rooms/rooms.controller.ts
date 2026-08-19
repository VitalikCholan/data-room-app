import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import type { AuthUser } from '../auth/auth.service'
import { RoomsService } from './rooms.service'
import { CreateRoomDto, RenameRoomDto } from './dto/room.dto'

@ApiTags('rooms')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a Data Room and its root folder' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRoomDto) {
    return this.rooms.create(user.id, dto.name)
  }

  @Get()
  @ApiOperation({ summary: 'List owned Data Rooms with subtree totals' })
  list(@CurrentUser() user: AuthUser) {
    return this.rooms.listOwned(user.id)
  }

  @Get('shared-with-me')
  @ApiOperation({ summary: 'Items shared with the signed-in user' })
  sharedWithMe(@CurrentUser() user: AuthUser) {
    return this.rooms.listSharedWithMe(user.email)
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a Data Room and its root folder' })
  @ApiResponse({
    status: 404,
    description: 'Not found or not owned by the caller',
  })
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RenameRoomDto,
  ) {
    return this.rooms.rename(user.id, id, dto.name)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a Data Room and everything in it' })
  @ApiResponse({
    status: 404,
    description: 'Not found or not owned by the caller',
  })
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.rooms.remove(user.id, id)
  }
}
