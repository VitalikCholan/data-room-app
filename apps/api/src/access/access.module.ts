import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { AccessResolver } from './access.resolver'
import { AccessGuard } from './access.guard'

@Module({
  imports: [JwtModule.register({})],
  providers: [AccessResolver, AccessGuard],
  exports: [AccessResolver, AccessGuard],
})
export class AccessModule {}
