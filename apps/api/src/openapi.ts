// First import, same as main.ts: modules evaluated below read process.env at
// import time, before ConfigModule gets a chance to load apps/api/.env.
import 'dotenv/config'
import 'reflect-metadata'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { SwaggerModule } from '@nestjs/swagger'
import { AppModule } from './app.module'
import { buildSwagger } from './swagger'

/**
 * Emits the contract the frontend generates its types from. Run in CI so a DTO change
 * that the frontend has not adopted fails the build rather than production.
 */
async function emit() {
  const app = await NestFactory.create(AppModule, { logger: false })
  const document = SwaggerModule.createDocument(app, buildSwagger())
  writeFileSync(
    join(__dirname, '..', 'openapi.json'),
    `${JSON.stringify(document, null, 2)}\n`,
  )
  await app.close()
  process.stdout.write('openapi.json written\n')
}
void emit()
