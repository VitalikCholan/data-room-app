import { Module } from '@nestjs/common'
import { RoomsService } from './rooms.service'
import { RoomsController } from './rooms.controller'
import { RollupService } from '../nodes/rollup.service'

@Module({
  controllers: [RoomsController],
  providers: [RoomsService, RollupService],
  exports: [RoomsService, RollupService],
})
export class RoomsModule {}
