import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { AccessResolver } from './access.resolver'
import { AccessGuard } from './access.guard'

@Module({
  imports: [JwtModule.register({})],
  providers: [AccessResolver, AccessGuard],
  // JwtModule must be re-exported, not just imported: AccessGuard is a real DI
  // consumer (it constructor-injects JwtService to verify tokens), and Nest only
  // resolves a provider through a grandparent import chain when the intermediate
  // module explicitly re-exports it. NodesModule is the first module to reach
  // AccessGuard from outside AccessModule itself — its `@UseGuards(AccessGuard)`
  // is a fresh DI lookup rooted at NodesModule, and without this re-export it fails
  // with "JwtService not available in NodesModule" even though AccessGuard and its
  // JwtService dependency are otherwise fully wired.
  exports: [AccessResolver, AccessGuard, JwtModule],
})
export class AccessModule {}
