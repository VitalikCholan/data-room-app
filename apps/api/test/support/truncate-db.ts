import { PrismaClient } from '../../src/generated/prisma/client'

/**
 * Shared afterAll cleanup for e2e specs. Each spec runs against the dedicated
 * `dataroom_test` database (see apps/api/.env.test) rather than development data, but
 * specs still share that one database with each other — `--runInBand` serializes them,
 * not isolates them. Truncating after every file keeps one spec's leftover rows (a
 * `Financials` folder, an `e2e-<uuid>@t.io` user, …) from ever being visible to the next.
 *
 * CASCADE handles FK order for us; RESTART IDENTITY is a no-op here since every id in
 * this schema is a uuid, not a serial, but it's harmless to include.
 */
export async function truncateDb(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "User", "DataRoom", "Node", "FileVersion", "Share" RESTART IDENTITY CASCADE',
  )
}
