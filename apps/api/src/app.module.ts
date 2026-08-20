import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { validateEnv } from './config/env'
import { HealthController } from './health/health.controller'
import { PrismaModule } from './prisma/prisma.module'
import { AuthModule } from './auth/auth.module'
import { RoomsModule } from './rooms/rooms.module'
import { AccessModule } from './access/access.module'
import { NodesModule } from './nodes/nodes.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    AuthModule,
    RoomsModule,
    AccessModule,
    NodesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
