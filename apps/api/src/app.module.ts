import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ScheduleModule } from '@nestjs/schedule'
import { validateEnv } from './config/env'
import { HealthController } from './health/health.controller'
import { PrismaModule } from './prisma/prisma.module'
import { AuthModule } from './auth/auth.module'
import { RoomsModule } from './rooms/rooms.module'
import { AccessModule } from './access/access.module'
import { NodesModule } from './nodes/nodes.module'
import { StorageModule } from './storage/storage.module'
import { UploadsModule } from './uploads/uploads.module'
import { FilesModule } from './files/files.module'
import { SharesModule } from './shares/shares.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    RoomsModule,
    AccessModule,
    NodesModule,
    StorageModule,
    UploadsModule,
    FilesModule,
    SharesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
