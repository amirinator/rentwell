/**
 * Integration test harness.
 *
 * These tests run against a real PostgreSQL database, because the things they
 * prove — that two concurrent approvals cannot both succeed, that a posting
 * cannot race past a close, that a unique index stops a duplicate payment — are
 * properties of the database, not of the application code. A mocked client
 * would assert nothing.
 *
 * Each test file gets a clean schema. Tests inside a file share it and are
 * responsible for their own records, which is why the suite runs single-worker.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterAll, beforeAll } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@rentwell/database';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://rentwell:rentwell@localhost:5432/rentwell_test?schema=public';

process.env.DATABASE_URL = DATABASE_URL;

// The API's config schema requires these; the values are irrelevant to the
// database tests but must be present for `loadConfig` to succeed.
process.env.SESSION_SECRET ??= 'integration-test-session-secret-long-enough';
process.env.S3_ACCESS_KEY_ID ??= 'test';
process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
process.env.AI_PROVIDER ??= 'mock';
process.env.NODE_ENV = 'test';

export const prisma: PrismaClient = createPrismaClient({ databaseUrl: DATABASE_URL });

/**
 * Applies the schema once per run.
 *
 * `prisma db push` rather than `migrate deploy`, because a test database only
 * needs to match the current schema; migration history is verified separately
 * by `scripts/db-bootstrap.mjs --verify` in CI.
 */
function ensureSchema(): void {
  if (process.env.SKIP_DB_PUSH === 'true') return;

  const databasePackage = new URL(
    '../../../../packages/database',
    import.meta.url,
  ).pathname.replace(/^\/([A-Za-z]:)/, '$1');

  // Prisma's entry point is resolved and run with this Node binary rather than
  // shelling out to `npx --yes`, which would reach for the registry if the
  // local copy were not found and could push the schema with a different
  // Prisma version than the one the workspace pins. It also keeps the call off
  // cmd.exe, where a path containing a space would be re-parsed.
  const prismaCli = createRequire(`${databasePackage}/package.json`).resolve(
    'prisma/build/index.js',
  );

  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    {
      cwd: databasePackage,
      env: { ...process.env, DATABASE_URL },
      stdio: 'inherit',
    },
  );
}

/** Truncates every table. Fast, and resets sequences with it. */
export async function resetDatabase(client: PrismaClient = prisma): Promise<void> {
  const tables = await client.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
  `;

  if (tables.length === 0) return;

  const list = tables.map((row) => `"public"."${row.tablename}"`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

beforeAll(async () => {
  ensureSchema();
  await prisma.$connect();
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});
