// dotenv first: this file is loaded by the Prisma CLI, which does not read .env for us.
import 'dotenv/config'
import { defineConfig } from 'prisma/config'

/**
 * `datasource` is attached only when DATABASE_URL is present. Prisma's `env()` helper throws
 * while the config file loads, which broke `prisma generate` — and therefore `pnpm install`'s
 * postinstall — on a fresh clone, before anyone had copied .env.example. Generating the client
 * needs no database; only the migrate commands do, and they fail with Prisma's own clear error
 * if the URL is genuinely missing.
 */
const url = process.env.DATABASE_URL

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // No `seed` entry yet — deliberately. Pointing it at a script that does not exist makes
    // `prisma migrate dev` hang waiting on a seed prompt with no TTY to answer it. Plan 06 adds
    // the entry in the same task that creates src/seed/seed.ts.
  },
  ...(url ? { datasource: { url } } : {}),
})
