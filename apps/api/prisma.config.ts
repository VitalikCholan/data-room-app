// dotenv first: this file is loaded by the Prisma CLI, which does not read .env for us.
import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // Wired here so `prisma db seed` works; the script itself arrives in plan 06.
    seed: 'ts-node src/seed/seed.ts',
  },
  datasource: { url: env('DATABASE_URL') },
})
