// First import, deliberately: modules evaluated below read process.env at import time,
// before ConfigModule gets a chance to load apps/api/.env.
import 'dotenv/config'
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { SwaggerModule } from '@nestjs/swagger'
import { AppModule } from './app.module'
import { buildSwagger } from './swagger'
import { configureApp } from './bootstrap'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  configureApp(app)
  app.enableCors({
    origin: [
      process.env.PUBLIC_APP_URL!,
      // The Vite dev server talks to the API directly (no /api rewrite) only outside
      // production, so this origin has no business being on the allowlist once deployed.
      ...(process.env.NODE_ENV !== 'production'
        ? ['http://localhost:5173']
        : []),
    ],
    credentials: true,
  })
  SwaggerModule.setup(
    'docs',
    app,
    SwaggerModule.createDocument(app, buildSwagger()),
  )
  app.enableShutdownHooks()
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0')
}
void bootstrap()
