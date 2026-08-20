// Loaded here explicitly: jest's `setupFiles` run per worker and only *after*
// globalSetup, so without this the guard below would see an empty `process.env` and
// reject a perfectly good `.env.test`. Importing it the same way `setupFiles` does
// (honouring `DOTENV_CONFIG_PATH`) means the guard inspects exactly the DATABASE_URL
// the specs will use.
import 'dotenv/config'
import { assertTestDatabase } from './support/require-test-database'

/**
 * Runs once, in the parent process, before any spec file is loaded — the only place a
 * guard can abort the *whole* run rather than fail spec by spec.
 */
export default function globalSetup(): void {
  assertTestDatabase()
}
