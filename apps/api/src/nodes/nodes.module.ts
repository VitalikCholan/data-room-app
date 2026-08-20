import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { NodesController } from './nodes.controller'
import { NodesRepository } from './nodes.repository'
import { NodesService } from './nodes.service'
import { RollupService } from './rollup.service'
import { MoveService } from './move.service'
import { DeleteService } from './delete.service'

@Module({
  imports: [AccessModule],
  controllers: [NodesController],
  providers: [
    NodesRepository,
    NodesService,
    RollupService,
    MoveService,
    DeleteService,
  ],
  exports: [
    NodesRepository,
    NodesService,
    RollupService,
    MoveService,
    DeleteService,
  ],
})
export class NodesModule {}
