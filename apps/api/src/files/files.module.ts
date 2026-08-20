import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { StorageModule } from '../storage/storage.module'
import { FilesController } from './files.controller'
import { FilesService } from './files.service'
import { VersionsService } from './versions.service'

@Module({
  imports: [AccessModule, StorageModule],
  controllers: [FilesController],
  providers: [FilesService, VersionsService],
})
export class FilesModule {}
