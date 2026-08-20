import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { NodesModule } from '../nodes/nodes.module'
import { StorageModule } from '../storage/storage.module'
import { UploadsController } from './uploads.controller'
import { UploadsService } from './uploads.service'

@Module({
  imports: [AccessModule, NodesModule, StorageModule],
  controllers: [UploadsController],
  providers: [UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}
