import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { NodesController } from './nodes.controller'
import { NodesRepository } from './nodes.repository'
import { NodesService } from './nodes.service'
import { RollupService } from './rollup.service'

@Module({
  imports: [AccessModule],
  controllers: [NodesController],
  providers: [NodesRepository, NodesService, RollupService],
  exports: [NodesRepository, NodesService, RollupService],
})
export class NodesModule {}
