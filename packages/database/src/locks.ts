/**
 * Accounting-period locking.
 *
 * The close-versus-posting race is the sharpest concurrency problem in the
 * system: a controller closes 2026-03 at the same moment a worker posts a
 * receipt into it. Row locks alone do not solve it, because the posting and the
 * close touch different rows.
 *
 * The rule, applied without exception:
 *
 *   **Acquire the period lock, then read the period's state, then act.**
 *
 * Both sides take a PostgreSQL transaction-scoped advisory lock keyed on
 * (propertyId, period). Whichever transaction acquires it first runs to
 * completion; the other blocks, and by the time it reads the period state it
 * sees the committed outcome. A posting that arrives after the close therefore
 * sees CLOSED and is rejected, instead of committing into a closed period.
 *
 * Advisory locks are released automatically at commit or rollback, so a crashed
 * worker cannot strand a property.
 */

import { DomainError, PeriodStatus, periodAcceptsPostings, type PeriodKey } from '@rentwell/domain';
import type { PrismaTransaction } from './client';

/**
 * 64-bit FNV-1a hash of a string, as a signed BigInt suitable for
 * `pg_advisory_xact_lock(bigint)`.
 *
 * A hash collision between two different (property, period) pairs would make
 * them share a lock. That costs a little concurrency and never costs
 * correctness, so a 64-bit hash is an acceptable trade for not needing a lock
 * registry table.
 */
export function advisoryLockKey(value: string): bigint {
  const PRIME = 1099511628211n;
  const MASK = (1n << 64n) - 1n;
  let hash = 14695981039346656037n;

  for (let i = 0; i < value.length; i += 1) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = (hash * PRIME) & MASK;
  }

  // pg advisory locks take a signed 64-bit integer.
  return hash >= 1n << 63n ? hash - (1n << 64n) : hash;
}

export function periodLockKey(propertyId: string, period: PeriodKey): bigint {
  return advisoryLockKey(`rentwell:period:${propertyId}:${period}`);
}

/**
 * Takes the transaction-scoped period lock. Blocks until it is available.
 * Must be the first statement of any transaction that posts into, or changes
 * the state of, an accounting period.
 */
export async function acquirePeriodLock(
  tx: PrismaTransaction,
  propertyId: string,
  period: PeriodKey,
): Promise<void> {
  const key = periodLockKey(propertyId, period);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`;
}

/**
 * Takes the period lock without blocking. Returns false when another
 * transaction holds it. Used by background jobs that would rather requeue than
 * hold a connection waiting behind a long close.
 */
export async function tryAcquirePeriodLock(
  tx: PrismaTransaction,
  propertyId: string,
  period: PeriodKey,
): Promise<boolean> {
  const key = periodLockKey(propertyId, period);
  const rows = await tx.$queryRaw<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(${key}::bigint) AS acquired
  `;
  return rows[0]?.acquired === true;
}

export interface LockedPeriod {
  readonly id: string;
  readonly propertyId: string;
  readonly period: PeriodKey;
  readonly status: PeriodStatus;
  readonly version: number;
}

/**
 * Acquires the period lock and returns the period row, creating it as OPEN if
 * this is the first activity in that month.
 *
 * Creation is done with an upsert on the (propertyId, period) unique index, so
 * two concurrent first-postings cannot create two rows.
 */
export async function lockPeriod(
  tx: PrismaTransaction,
  organizationId: string,
  propertyId: string,
  period: PeriodKey,
): Promise<LockedPeriod> {
  await acquirePeriodLock(tx, propertyId, period);

  const row = await tx.accountingPeriod.upsert({
    where: { propertyId_period: { propertyId, period } },
    create: { organizationId, propertyId, period, status: 'OPEN' },
    update: {},
    select: { id: true, propertyId: true, period: true, status: true, version: true },
  });

  return {
    id: row.id,
    propertyId: row.propertyId,
    period: row.period,
    status: row.status as PeriodStatus,
    version: row.version,
  };
}

/**
 * Acquires the lock and rejects the caller unless the period accepts postings.
 *
 * Every financial write path calls this before touching a charge, allocation or
 * journal entry. Because the check happens under the lock, a close committed a
 * microsecond earlier is already visible here.
 */
export async function lockPeriodForPosting(
  tx: PrismaTransaction,
  organizationId: string,
  propertyId: string,
  period: PeriodKey,
): Promise<LockedPeriod> {
  const locked = await lockPeriod(tx, organizationId, propertyId, period);

  if (!periodAcceptsPostings(locked.status)) {
    throw new DomainError(
      'PERIOD_CLOSED',
      `Accounting period ${period} is closed for this property and rejects financial changes.`,
      { details: { propertyId, period, status: locked.status } },
    );
  }

  return locked;
}

/**
 * Locks several periods in a deterministic order.
 *
 * Ordering is the whole point: a transaction that touches two periods must take
 * their locks in the same sequence as every other transaction, or two of them
 * can deadlock holding one lock each.
 */
export async function lockPeriodsInOrder(
  tx: PrismaTransaction,
  organizationId: string,
  refs: readonly { propertyId: string; period: PeriodKey }[],
): Promise<LockedPeriod[]> {
  const unique = new Map<string, { propertyId: string; period: PeriodKey }>();
  for (const ref of refs) unique.set(`${ref.propertyId}|${ref.period}`, ref);

  const ordered = [...unique.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, ref]) => ref);

  const locked: LockedPeriod[] = [];
  for (const ref of ordered) {
    locked.push(await lockPeriod(tx, organizationId, ref.propertyId, ref.period));
  }
  return locked;
}

/** Bumps a period's version. Called on every state change. */
export async function bumpPeriodVersion(
  tx: PrismaTransaction,
  periodId: string,
  expectedVersion: number,
): Promise<void> {
  const result = await tx.accountingPeriod.updateMany({
    where: { id: periodId, version: expectedVersion },
    data: { version: { increment: 1 } },
  });
  if (result.count === 0) {
    throw new DomainError(
      'STALE_RECORD',
      'The accounting period changed while this work was in flight',
      {
        details: { periodId, expectedVersion },
      },
    );
  }
}
