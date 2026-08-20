import { Module } from '@nestjs/common'
import { AccessModule } from '../access/access.module'
import { AuthModule } from '../auth/auth.module'
import { SharesController } from './shares.controller'
import { PublicShareController } from './public-share.controller'
import { SharesService } from './shares.service'

@Module({
  imports: [AccessModule, AuthModule],
  controllers: [SharesController, PublicShareController],
  providers: [SharesService],
})
export class SharesModule {}
