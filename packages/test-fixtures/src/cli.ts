#!/usr/bin/env node
/**
 * Seed command.
 *
 *   pnpm seed              # seed into an empty database
 *   pnpm seed:reset        # clear everything first, then seed
 *
 * `--reset` is the documented way to get back to a known state. Because the
 * generator is seeded, a reset reproduces the same portfolio every time, which
 * is what lets the demo guide name specific records.
 */

import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { createPrismaClient } from '@rentwell/database';
import { DEMO_PASSWORD, seed } from './seed';

// Run through ts-node, which loads no env file, so .env has to be read here or
// the DATABASE_URL check below fails for someone who followed the README
// exactly. `override: false` keeps a real environment variable authoritative,
// which is what CI relies on when it seeds against its own service container.
loadDotenv({ path: resolve(__dirname, '../../../.env'), override: false });

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const seedArgument = process.argv.find((argument) => argument.startsWith('--seed='));
  const seedValue = seedArgument?.split('=')[1];

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }

  const prisma = createPrismaClient();

  try {
    const startedAt = Date.now();

    // CI seeds a smaller portfolio: the browser tests need the scenarios, not
    // 28 properties' worth of data.
    const propertyCount = Number.parseInt(process.env.SEED_PROPERTY_COUNT ?? '', 10);
    const leaseCount = Number.parseInt(process.env.SEED_LEASE_COUNT ?? '', 10);

    const summary = await seed(prisma, {
      reset,
      ...(seedValue ? { seed: seedValue } : {}),
      ...(Number.isInteger(propertyCount) && propertyCount > 0 ? { propertyCount } : {}),
      ...(Number.isInteger(leaseCount) && leaseCount > 0 ? { leaseCount } : {}),
      log: (message) => console.log(`  ${message}`),
    });

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    console.log('');
    console.log(`Seeded in ${seconds}s:`);
    console.log(`  organizations  ${summary.organizations}`);
    console.log(`  properties     ${summary.properties}`);
    console.log(`  units          ${summary.units}`);
    console.log(`  tenants        ${summary.tenants}`);
    console.log(`  leases         ${summary.leases}`);
    console.log(`  charges        ${summary.charges}`);
    console.log(`  payments       ${summary.transactions}`);

    console.log('');
    console.log('Scenarios to look for:');
    for (const [name, detail] of Object.entries(summary.scenarios).sort()) {
      console.log(`  ${name.padEnd(22)} ${detail}`);
    }

    console.log('');
    console.log(`Sign in at http://localhost:5173 with password: ${DEMO_PASSWORD}`);
    console.log('  admin@rentwell.example        organization administrator');
    console.log('  controller@rentwell.example   portfolio controller');
    console.log('  accountant@rentwell.example   accountant (6 properties only)');
    console.log('  manager@rentwell.example      property manager (2 properties only)');
    console.log('  auditor@rentwell.example      auditor (read-only)');
    console.log('  accountant@northharbour.example  a second organization, for isolation checks');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
