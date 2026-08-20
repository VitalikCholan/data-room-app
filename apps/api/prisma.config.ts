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
    // Safe to wire only now that src/seed/seed.ts exists: an entry pointing at a missing
    // script makes `prisma migrate dev` hang on a seed prompt with no TTY to answer it,
    // which is why plan 01 left this out. It delegates to the package script rather than
    // naming a runner, because the seed has to run compiled — ts-node cannot load the
    // generated Prisma client, whose internal requires use `.js` specifiers that point at
    // sibling `.ts` files (the same mismatch jest.config.js works around with
    // moduleNameMapper).
    seed: 'pnpm run seed',
  },
  ...(url ? { datasource: { url } } : {}),
})
