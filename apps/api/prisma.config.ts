// dotenv first: this file is loaded by the Prisma CLI, which does not read .env for us.
import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // No `seed` entry yet — deliberately. Pointing it at a script that does not exist makes
    // `prisma migrate dev` hang waiting on a seed prompt with no TTY to answer it. Plan 06 adds
    // the entry in the same task that creates src/seed/seed.ts.
  },
  datasource: { url: env('DATABASE_URL') },
})
