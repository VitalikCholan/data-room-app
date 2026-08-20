/**
 * Refuse to run the e2e suite against anything but a dedicated test database.
 *
 * This is a data-loss guard, not a style rule. Every spec truncates the whole schema in
 * `afterAll` (see truncate-db.ts), so whichever database `DATABASE_URL` names is emptied
 * by a green run. `test:e2e` sets `DOTENV_CONFIG_PATH=.env.test`, but `.env.test` is
 * gitignored: on a fresh clone it does not exist, dotenv then loads nothing, and
 * `ConfigModule.forRoot()` falls back to `apps/api/.env` — the *development* database.
 * The suite passes and the development data is gone. So the name is checked instead of
 * assumed.
 *
 * `_test` as the required suffix rather than an exact match, so a second worktree or a
 * per-branch database (`dataroom_branch_test`) still works.
 */
const REMEDY = [
  'Create apps/api/.env.test from apps/api/.env.test.example, then create and migrate that database:',
  '  cp apps/api/.env.test.example apps/api/.env.test',
  '  docker compose exec -T postgres createdb -U dataroom dataroom_test',
  '  DATABASE_URL="postgresql://dataroom:dataroom@localhost:5433/dataroom_test?schema=public" \\',
  '    pnpm --filter api exec prisma migrate deploy',
].join('\n')

function databaseName(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/^\//, '') || null
  } catch {
    return null
  }
}

export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'Refusing to run the e2e suite: DATABASE_URL is not set, so the suite has no ' +
        'configuration at all and would truncate whatever database the app falls back to.\n' +
        REMEDY,
    )
  }

  const name = databaseName(url)
  if (!name || !name.endsWith('_test')) {
    throw new Error(
      `Refusing to run the e2e suite: DATABASE_URL points at the database "${
        name ?? url
      }", whose name does not end in "_test". Every spec truncates every table, so this ` +
        'run would destroy that data — the development database is the usual accident.\n' +
        REMEDY,
    )
  }
}
