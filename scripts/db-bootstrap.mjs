#!/usr/bin/env node
/**
 * Database bootstrap.
 *
 * On a clean checkout there is no migration history yet. Rather than shipping a
 * hand-written baseline that could drift from schema.prisma, this script asks
 * Prisma to derive the baseline from the schema itself:
 *
 *   1. If `prisma/migrations` has no migration, generate one with
 *      `prisma migrate diff --from-empty --to-schema-datamodel`, which is
 *      guaranteed to match the schema exactly.
 *   2. Apply all migrations with `prisma migrate deploy`.
 *   3. Verify no drift remains with a second `migrate diff`, this time from the
 *      applied database to the schema. A non-empty result is a hard failure.
 *
 * Step 3 is the important one: it is the same check CI runs, so a schema edit
 * without a matching migration fails loudly instead of silently diverging.
 *
 * Usage:
 *   node scripts/db-bootstrap.mjs            # generate if needed, apply, verify
 *   node scripts/db-bootstrap.mjs --verify   # verify only, never write
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// The settings live in .env, and nothing else loads it: this script is run as
// plain `node`, which reads no env file of its own. Without this the check
// below reports that DATABASE_URL is unset and tells the reader to create the
// very file they already created. `override: false` leaves a real environment
// variable untouched, so CI — which runs this script directly with the
// database URL exported — is unaffected.
loadDotenv({ path: join(repoRoot, '.env'), override: false });
const databasePackage = join(repoRoot, 'packages', 'database');
const schemaPath = join(databasePackage, 'prisma', 'schema.prisma');
const migrationsDir = join(databasePackage, 'prisma', 'migrations');

const verifyOnly = process.argv.includes('--verify');

// Prisma is run as a plain Node script rather than through `npx`.
//
// `npx` cannot be spawned portably here: on Windows the launcher is npx.cmd,
// execFileSync applies no PATHEXT resolution (ENOENT), and since Node 18.20 /
// 20.12 spawning a .cmd without a shell is refused outright (EINVAL). Passing
// `shell: true` would work but hands the absolute schema path to cmd.exe to
// re-parse, which breaks as soon as a directory contains a space.
//
// Resolving the CLI's entry point also pins the workspace's own Prisma instead
// of letting `npx --yes` fall back to fetching a different version.
const prismaCli = createRequire(join(databasePackage, 'package.json')).resolve(
  'prisma/build/index.js',
);

function run(args, options = {}) {
  return execFileSync(process.execPath, [prismaCli, ...args], {
    cwd: databasePackage,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: process.env,
  });
}

function hasExistingMigration() {
  if (!existsSync(migrationsDir)) return false;
  return readdirSync(migrationsDir, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && existsSync(join(migrationsDir, entry.name, 'migration.sql')),
  );
}

function createBaselineMigration() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14);
  const folder = join(migrationsDir, `${stamp}_init`);
  mkdirSync(folder, { recursive: true });

  console.log('No migration history found. Deriving a baseline from schema.prisma...');
  const sql = run(
    ['migrate', 'diff', '--from-empty', '--to-schema-datamodel', schemaPath, '--script'],
    { capture: true },
  );

  const header = [
    '-- Rentwell baseline migration.',
    '-- Generated from prisma/schema.prisma by scripts/db-bootstrap.mjs.',
    '-- Requires the pgcrypto and citext extensions, created by',
    '-- infra/postgres/init/01-extensions.sql when the container is first built.',
    'CREATE EXTENSION IF NOT EXISTS "pgcrypto";',
    'CREATE EXTENSION IF NOT EXISTS "citext";',
    '',
  ].join('\n');

  writeFileSync(join(folder, 'migration.sql'), `${header}${sql}`, 'utf8');
  console.log(`Wrote ${join(folder, 'migration.sql')}`);
}

function verifyNoDrift() {
  console.log('Verifying the database matches schema.prisma...');
  const diff = run(
    [
      'migrate',
      'diff',
      '--from-url',
      process.env.DATABASE_URL ?? '',
      '--to-schema-datamodel',
      schemaPath,
      '--script',
    ],
    { capture: true },
  );

  const meaningful = diff
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('--'));

  if (meaningful.length > 0) {
    console.error('\nDatabase schema drift detected. The applied migrations do not');
    console.error('produce the schema described by prisma/schema.prisma:\n');
    console.error(diff);
    console.error('Run `pnpm --filter @rentwell/database migrate:dev --name <change>`');
    console.error('to record a migration for your schema edit.');
    process.exit(1);
  }

  console.log('No drift. Database matches the schema.');
}

function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }

  if (verifyOnly) {
    verifyNoDrift();
    return;
  }

  if (!hasExistingMigration()) createBaselineMigration();

  console.log('Applying migrations...');
  run(['migrate', 'deploy']);

  console.log('Generating the Prisma client...');
  run(['generate']);

  verifyNoDrift();
}

main();
