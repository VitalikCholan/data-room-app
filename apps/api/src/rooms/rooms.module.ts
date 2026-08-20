import { Module } from '@nestjs/common'
import { RoomsService } from './rooms.service'
import { RoomsController } from './rooms.controller'
import { NodesModule } from '../nodes/nodes.module'

@Module({
  imports: [NodesModule],
  controllers: [RoomsController],
  providers: [RoomsService],
  exports: [RoomsService],
})
export class RoomsModule {}
