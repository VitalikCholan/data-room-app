import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { StorageModule } from '../storage/storage.module'
import { FilesController } from './files.controller'
import { FilesService } from './files.service'

@Module({
  imports: [AccessModule, StorageModule],
  controllers: [FilesController],
  providers: [FilesService],
})
export class FilesModule {}
