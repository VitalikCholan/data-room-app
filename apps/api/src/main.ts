// First import, deliberately: modules evaluated below read process.env at import time,
// before ConfigModule gets a chance to load apps/api/.env.
import 'dotenv/config'
import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { SwaggerModule } from '@nestjs/swagger'
import cookieParser from 'cookie-parser'
import { AppModule } from './app.module'
import { buildSwagger } from './swagger'
import { DomainExceptionFilter } from './common/filters/domain-exception.filter'
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter'
import { BigIntInterceptor } from './common/interceptors/bigint.interceptor'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.use(cookieParser())
  app.enableCors({
    origin: [process.env.PUBLIC_APP_URL!, 'http://localhost:5173'],
    credentials: true,
  })
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  )
  // Global filters apply right to left, so the more specific Prisma filter must come
  // first — it needs first refusal on Prisma errors before the domain filter runs.
  app.useGlobalFilters(new PrismaExceptionFilter(), new DomainExceptionFilter())
  app.useGlobalInterceptors(new BigIntInterceptor())
  SwaggerModule.setup(
    'docs',
    app,
    SwaggerModule.createDocument(app, buildSwagger()),
  )
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0')
}
void bootstrap()
