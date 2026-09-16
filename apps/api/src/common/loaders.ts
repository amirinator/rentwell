/**
 * Per-request DataLoaders.
 *
 * Two jobs:
 *
 *  1. Batching. A list of 25 charges asks for 25 tenants; without a loader that
 *    is 25 queries. With one it is a single `IN (...)`.
 *  2. Containment. Every loader is constructed with the viewer's organization
 *    id and filters on it, so a resolver that looks up an id taken from
 *    arbitrary input cannot return a row from another organization even if it
 *    forgets to check. The authorization helpers still run; this is the second
 *    layer, not the first.
 *
 * Loaders are created per request. They must never be cached across requests,
 * because their results are scoped to one viewer's organization.
 */

import DataLoader from 'dataloader';
import { centsFromDb, type PrismaClient } from '@rentwell/database';

type Row = Record<string, unknown> & { id: string };

/**
 * Builds a loader that fetches by id within one organization, preserving the
 * order of the requested keys as DataLoader requires.
 */
function byId<T extends Row>(
  fetch: (ids: readonly string[]) => Promise<T[]>,
): DataLoader<string, T | null> {
  return new DataLoader<string, T | null>(
    async (ids) => {
      const rows = await fetch(ids);
      const index = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => index.get(id) ?? null);
    },
    { maxBatchSize: 200 },
  );
}

export interface Loaders {
  property: DataLoader<string, Row | null>;
  unit: DataLoader<string, Row | null>;
  tenant: DataLoader<string, Row | null>;
  lease: DataLoader<string, Row | null>;
  charge: DataLoader<string, Row | null>;
  bankAccount: DataLoader<string, Row | null>;
  transaction: DataLoader<string, Row | null>;
  user: DataLoader<string, Row | null>;
  /** Active allocations for a transaction. */
  allocationsByTransaction: DataLoader<string, Row[]>;
  /** Active allocations against a charge. */
  allocationsByCharge: DataLoader<string, Row[]>;
  /** Charge schedules with their versions, for a lease. */
  schedulesByLease: DataLoader<string, Row[]>;
  /** Accounting period rows, keyed `propertyId|period`. */
  accountingPeriod: DataLoader<string, Row | null>;
  /**
   * The newest unresolved exception for a transaction, if it has one.
   *
   * The transactions list asks for this on every row, so without a loader a
   * page of 25 transactions runs 25 extra queries.
   */
  openExceptionByTransaction: DataLoader<string, Row | null>;
  /**
   * Aggregates shown on a property card.
   *
   * A loader rather than a plain query because five separate field resolvers
   * ask for pieces of the same result. Without it, a list of 25 properties
   * would run 125 aggregate queries instead of a handful.
   */
  propertyStats: DataLoader<string, PropertyStats>;
}

export interface PropertyStats {
  readonly unitCount: number;
  readonly activeLeaseCount: number;
  readonly outstandingCents: number;
  readonly unappliedCashCents: number;
  readonly openExceptionCount: number;
}

export function createLoaders(prisma: PrismaClient, organizationId: string): Loaders {
  const scope = { organizationId };

  return {
    property: byId(
      (ids) =>
        prisma.property.findMany({ where: { ...scope, id: { in: [...ids] } } }) as Promise<Row[]>,
    ),

    unit: byId(
      (ids) =>
        prisma.unit.findMany({ where: { ...scope, id: { in: [...ids] } } }) as Promise<Row[]>,
    ),

    tenant: byId(
      (ids) =>
        prisma.tenant.findMany({ where: { ...scope, id: { in: [...ids] } } }) as Promise<Row[]>,
    ),

    lease: byId(
      (ids) =>
        prisma.lease.findMany({
          where: { ...scope, id: { in: [...ids] } },
          include: { tenant: true, unit: true },
        }) as Promise<Row[]>,
    ),

    charge: byId(
      (ids) =>
        prisma.charge.findMany({
          where: { ...scope, id: { in: [...ids] } },
          include: { lease: { include: { tenant: true } } },
        }) as Promise<Row[]>,
    ),

    bankAccount: byId(
      (ids) =>
        prisma.bankAccount.findMany({ where: { ...scope, id: { in: [...ids] } } }) as Promise<
          Row[]
        >,
    ),

    transaction: byId(
      (ids) =>
        prisma.bankTransaction.findMany({
          where: { ...scope, id: { in: [...ids] } },
        }) as Promise<Row[]>,
    ),

    // Users are global, but only ones with a membership in this organization
    // are visible, so a user id from elsewhere resolves to null. The membership
    // is loaded with them, because every place that shows a person also shows
    // their role, and inventing one would misrepresent who approved what.
    user: byId(async (ids) => {
      const rows = await prisma.user.findMany({
        where: { id: { in: [...ids] }, memberships: { some: { organizationId } } },
        select: {
          id: true,
          email: true,
          displayName: true,
          memberships: {
            where: { organizationId },
            select: { id: true, role: true, status: true },
            take: 1,
          },
        },
      });
      return rows.map((row) => ({
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        membershipId: row.memberships[0]?.id ?? null,
        role: row.memberships[0]?.role ?? null,
        membershipStatus: row.memberships[0]?.status ?? null,
      })) as unknown as Row[];
    }),

    allocationsByTransaction: groupedLoader(async (ids) => {
      const rows = await prisma.allocation.findMany({
        where: { ...scope, transactionId: { in: [...ids] }, status: 'ACTIVE' },
        orderBy: { approvedAt: 'asc' },
      });
      return rows.map((row) => [row.transactionId, row as unknown as Row] as const);
    }),

    allocationsByCharge: groupedLoader(async (ids) => {
      const rows = await prisma.allocation.findMany({
        where: { ...scope, chargeId: { in: [...ids] }, status: 'ACTIVE' },
        orderBy: { approvedAt: 'asc' },
      });
      return rows.map((row) => [row.chargeId, row as unknown as Row] as const);
    }),

    schedulesByLease: groupedLoader(async (ids) => {
      const rows = await prisma.chargeSchedule.findMany({
        where: { ...scope, leaseId: { in: [...ids] } },
        include: { versions: { orderBy: { versionNumber: 'asc' } } },
      });
      return rows.map((row) => [row.leaseId, row as unknown as Row] as const);
    }),

    accountingPeriod: byId(async (keys) => {
      const parsed = keys.map((key) => {
        const [propertyId, period] = key.split('|');
        return { propertyId: propertyId ?? '', period: period ?? '' };
      });
      const rows = await prisma.accountingPeriod.findMany({
        where: {
          ...scope,
          OR: parsed.map(({ propertyId, period }) => ({ propertyId, period })),
        },
      });
      // Re-key on the composite so `byId` can index it.
      return rows.map((row) => ({
        ...row,
        id: `${row.propertyId}|${row.period}`,
      })) as unknown as Row[];
    }),

    // Not built on `byId`, which indexes on `row.id`: re-keying the row to the
    // transaction id would overwrite the exception's own id, and the view needs
    // it to build the record the client links to.
    openExceptionByTransaction: new DataLoader<string, Row | null>(
      async (transactionIds) => {
        const rows = (await prisma.reconciliationException.findMany({
          where: {
            ...scope,
            transactionId: { in: [...transactionIds] },
            status: { not: 'RESOLVED' },
          },
          orderBy: { createdAt: 'desc' },
        })) as unknown as Row[];

        // Newest first, so the first row seen for a transaction is the one kept.
        const index = new Map<string, Row>();
        for (const row of rows) {
          const key = row.transactionId as string | null;
          if (key !== null && !index.has(key)) index.set(key, row);
        }
        return transactionIds.map((id) => index.get(id) ?? null);
      },
      { maxBatchSize: 200 },
    ),

    propertyStats: new DataLoader<string, PropertyStats>(
      async (propertyIds) => {
        const ids = [...propertyIds];
        const scoped = { organizationId, propertyId: { in: ids } };

        // Five grouped queries for the whole batch, rather than five per property.
        const [units, leases, charges, unapplied, exceptions] = await Promise.all([
          prisma.unit.groupBy({
            by: ['propertyId'],
            where: { propertyId: { in: ids } },
            _count: { _all: true },
          }),
          prisma.lease.groupBy({
            by: ['propertyId'],
            where: { ...scoped, status: 'ACTIVE' },
            _count: { _all: true },
          }),
          prisma.charge.groupBy({
            by: ['propertyId'],
            where: { ...scoped, status: { in: ['POSTED', 'SETTLED'] } },
            _sum: { amountCents: true, allocatedCents: true, creditedCents: true },
          }),
          prisma.bankTransaction.groupBy({
            by: ['propertyId'],
            where: {
              ...scoped,
              direction: 'CREDIT',
              status: { in: ['UNAPPLIED', 'PARTIALLY_ALLOCATED'] },
            },
            _sum: { amountCents: true, allocatedCents: true },
          }),
          prisma.reconciliationException.groupBy({
            by: ['propertyId'],
            where: { ...scoped, status: { not: 'RESOLVED' } },
            _count: { _all: true },
          }),
        ]);

        const unitCounts = new Map(units.map((row) => [row.propertyId, row._count._all]));
        const leaseCounts = new Map(leases.map((row) => [row.propertyId, row._count._all]));
        const exceptionCounts = new Map(exceptions.map((row) => [row.propertyId, row._count._all]));
        const outstanding = new Map(
          charges.map((row) => [
            row.propertyId,
            toNumber(row._sum.amountCents) -
              toNumber(row._sum.allocatedCents) -
              toNumber(row._sum.creditedCents),
          ]),
        );
        const unappliedCash = new Map(
          unapplied.map((row) => [
            row.propertyId,
            toNumber(row._sum.amountCents) - toNumber(row._sum.allocatedCents),
          ]),
        );

        return ids.map((id) => ({
          unitCount: unitCounts.get(id) ?? 0,
          activeLeaseCount: leaseCounts.get(id) ?? 0,
          outstandingCents: outstanding.get(id) ?? 0,
          unappliedCashCents: unappliedCash.get(id) ?? 0,
          openExceptionCount: exceptionCounts.get(id) ?? 0,
        }));
      },
      { maxBatchSize: 100 },
    ),
  };
}

/**
 * BIGINT aggregates arrive as bigint; zero for an empty group.
 *
 * Routed through `centsFromDb` rather than a bare `Number()`, because a bare
 * conversion past 2^53 rounds silently. An aggregate is exactly where that
 * could happen, and a wrong total is worse than a failed request.
 */
function toNumber(value: bigint | number | null): number {
  return centsFromDb(value);
}

/**
 * Builds a one-to-many loader from a flat result set. Keys with no rows get an
 * empty array rather than null, which is what a list field wants.
 */
function groupedLoader<T>(
  fetch: (keys: readonly string[]) => Promise<readonly (readonly [string, T])[]>,
): DataLoader<string, T[]> {
  return new DataLoader<string, T[]>(
    async (keys) => {
      const pairs = await fetch(keys);
      const grouped = new Map<string, T[]>();
      for (const [key, value] of pairs) {
        const bucket = grouped.get(key);
        if (bucket) bucket.push(value);
        else grouped.set(key, [value]);
      }
      return keys.map((key) => grouped.get(key) ?? []);
    },
    { maxBatchSize: 200 },
  );
}

/** Composite key for the accounting-period loader. */
export function periodLoaderKey(propertyId: string, period: string): string {
  return `${propertyId}|${period}`;
}
