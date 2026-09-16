/**
 * Portfolio dashboard.
 *
 * Every figure on this screen is something an accountant may be asked to
 * defend, so each one ships with a `MetricNote` stating the filters it used,
 * the date field the period was applied to, and how reversed and credited
 * records were treated. A number without that description is not auditable, and
 * two dashboards that disagree are usually two different date bases rather than
 * a bug.
 *
 * Aging is computed as of an explicit reporting date, never "now", so refreshing
 * the page at 23:59 and 00:01 does not silently move a charge between buckets.
 */

import { Injectable } from '@nestjs/common';
import { periodEnd, type AccessContext, type LocalDate, type PeriodKey } from '@rentwell/domain';
import { Prisma, centsFromDb, outboxLagSeconds } from '@rentwell/database';
import { PrismaService } from '../prisma/prisma.service';
import { authorize, resolvePropertyScope } from '../common/guards';
import type { GqlContext } from '../common/context';

export interface AgingBucketResult {
  label: string;
  minDaysPastDue: number;
  maxDaysPastDue: number | null;
  amountCents: number;
  chargeCount: number;
}

export interface ExceptionBucketResult {
  key: string;
  label: string;
  count: number;
  amountCents: number;
}

export interface PortfolioSummaryResult {
  period: PeriodKey;
  propertyIds: string[];
  currency: string;
  chargesPostedCents: number;
  paymentsReceivedCents: number;
  paymentsAllocatedCents: number;
  unappliedCashCents: number;
  outstandingReceivablesCents: number;
  allocationRate: number;
  suggestionCoverage: number;
  aging: AgingBucketResult[];
  exceptionsBySeverity: ExceptionBucketResult[];
  exceptionsByOwner: ExceptionBucketResult[];
  closeStatus: { propertyId: string; period: PeriodKey; status: string; blockerCount: number }[];
  processing: {
    failedImports: number;
    importsInProgress: number;
    pendingOutboxEvents: number;
    oldestPendingEventAgeSeconds: number;
    deadLetterEvents: number;
  };
  asOfDate: LocalDate;
  refreshedAt: string;
  metricNotes: { metric: string; dateBasis: string; reversalTreatment: string; filters: string }[];
}

/** Bucket edges in days past due. The last bucket is open-ended. */
const AGING_BUCKETS: readonly { label: string; min: number; max: number | null }[] = [
  { label: 'Current', min: -36_500, max: 0 },
  { label: '1-30 days', min: 1, max: 30 },
  { label: '31-60 days', min: 31, max: 60 },
  { label: '61-90 days', min: 61, max: 90 },
  { label: 'Over 90 days', min: 91, max: null },
];

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(
    ctx: GqlContext,
    filter: { propertyIds?: string[] | null; period: PeriodKey; asOfDate?: LocalDate | null },
  ): Promise<PortfolioSummaryResult> {
    const access = authorize(ctx, 'dashboard:read');
    const scope = resolvePropertyScope(access, filter.propertyIds);
    const asOfDate = filter.asOfDate ?? periodEnd(filter.period);

    const propertyWhere = scope === null ? {} : { propertyId: { in: scope } };
    const organizationWhere = { organizationId: access.organizationId };

    const [
      properties,
      chargeTotals,
      transactionTotals,
      aging,
      severityRows,
      ownerRows,
      periodRows,
      failedImports,
      importsInProgress,
      pendingOutbox,
      deadLetter,
      outboxLag,
      suggestionCoverage,
    ] = await Promise.all([
      this.prisma.client.property.findMany({
        where: { ...organizationWhere, ...(scope ? { id: { in: scope } } : {}) },
        select: { id: true, currency: true },
        orderBy: { code: 'asc' },
      }),
      this.prisma.client.charge.aggregate({
        where: { ...organizationWhere, ...propertyWhere, period: filter.period },
        _sum: { amountCents: true },
      }),
      this.prisma.client.bankTransaction.aggregate({
        where: {
          ...organizationWhere,
          ...propertyWhere,
          period: filter.period,
          direction: 'CREDIT',
          status: { not: 'REVERSED' },
        },
        _sum: { amountCents: true, allocatedCents: true },
      }),
      // Outstanding and aging are cumulative through the reporting date, not
      // period movements: a tenant's arrears do not reset each month. The
      // bucketing happens in SQL against the maintained `openCents` column, so
      // this does not load a portfolio's entire charge history into memory.
      this.agingBuckets(access, scope, filter.period, asOfDate),
      this.prisma.client.reconciliationException.groupBy({
        by: ['severity'],
        where: { ...organizationWhere, ...propertyWhere, status: { not: 'RESOLVED' } },
        _count: { _all: true },
        _sum: { openAmountCents: true },
      }),
      this.prisma.client.reconciliationException.groupBy({
        by: ['assignedToUserId'],
        where: { ...organizationWhere, ...propertyWhere, status: { not: 'RESOLVED' } },
        _count: { _all: true },
        _sum: { openAmountCents: true },
      }),
      this.prisma.client.accountingPeriod.findMany({
        where: {
          ...organizationWhere,
          ...(scope ? { propertyId: { in: scope } } : {}),
          period: filter.period,
        },
        select: { propertyId: true, period: true, status: true },
      }),
      this.prisma.client.importBatch.count({
        where: {
          ...organizationWhere,
          ...propertyWhere,
          status: { in: ['FAILED', 'VALIDATION_FAILED'] },
        },
      }),
      this.prisma.client.importBatch.count({
        where: {
          ...organizationWhere,
          ...propertyWhere,
          status: { in: ['DRAFT', 'VALIDATING', 'READY', 'QUEUED', 'PROCESSING'] },
        },
      }),
      this.prisma.client.outboxEvent.count({
        where: { ...organizationWhere, status: { in: ['PENDING', 'FAILED'] } },
      }),
      this.prisma.client.outboxEvent.count({
        where: { ...organizationWhere, status: 'DEAD_LETTER' },
      }),
      outboxLagSeconds(this.prisma.client),
      this.suggestionCoverage(access, propertyWhere, filter.period),
    ]);

    const currency = properties[0]?.currency.trim() ?? 'USD';

    const chargesPostedCents = centsFromDb(chargeTotals._sum.amountCents);
    const paymentsReceivedCents = centsFromDb(transactionTotals._sum.amountCents);
    const paymentsAllocatedCents = centsFromDb(transactionTotals._sum.allocatedCents);

    const outstandingReceivablesCents = aging.reduce(
      (total, bucket) => total + bucket.amountCents,
      0,
    );

    // Unapplied cash is cumulative too: money received in January and still
    // unmatched in March is unapplied in March.
    const unappliedAggregate = await this.prisma.client.bankTransaction.aggregate({
      where: {
        ...organizationWhere,
        ...propertyWhere,
        direction: 'CREDIT',
        status: { in: ['UNAPPLIED', 'PARTIALLY_ALLOCATED'] },
        period: { lte: filter.period },
      },
      _sum: { amountCents: true, allocatedCents: true },
    });
    const unappliedCashCents =
      centsFromDb(unappliedAggregate._sum.amountCents) -
      centsFromDb(unappliedAggregate._sum.allocatedCents);

    const blockerCounts = await this.blockerCounts(access, scope, filter.period);

    return {
      period: filter.period,
      propertyIds: properties.map((property) => property.id),
      currency,
      chargesPostedCents,
      paymentsReceivedCents,
      paymentsAllocatedCents,
      unappliedCashCents,
      outstandingReceivablesCents,
      allocationRate:
        paymentsReceivedCents === 0 ? 0 : round4(paymentsAllocatedCents / paymentsReceivedCents),
      suggestionCoverage,
      aging,
      exceptionsBySeverity: severityRows
        .map((row) => ({
          key: row.severity,
          label: row.severity,
          count: row._count._all,
          amountCents: centsFromDb(row._sum.openAmountCents),
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      exceptionsByOwner: await this.labelOwners(access, ownerRows),
      closeStatus: periodRows.map((row) => ({
        propertyId: row.propertyId,
        period: row.period,
        status: row.status,
        blockerCount: blockerCounts.get(row.propertyId) ?? 0,
      })),
      processing: {
        failedImports,
        importsInProgress,
        pendingOutboxEvents: pendingOutbox,
        oldestPendingEventAgeSeconds: outboxLag,
        deadLetterEvents: deadLetter,
      },
      asOfDate,
      refreshedAt: new Date().toISOString(),
      metricNotes: buildMetricNotes(filter.period, asOfDate, scope),
    };
  }

  /**
   * Buckets outstanding balances by days past due on the reporting date.
   *
   * A charge contributes its open balance, not its gross amount: a half-paid
   * invoice is half as overdue, which is what a collections conversation is
   * actually about.
   *
   * Grouping happens in PostgreSQL. Doing it in application code would mean
   * transferring every open charge in the portfolio on every dashboard load.
   */
  private async agingBuckets(
    access: AccessContext,
    scope: string[] | null,
    throughPeriod: PeriodKey,
    asOfDate: LocalDate,
  ): Promise<AgingBucketResult[]> {
    const asOf = new Date(`${asOfDate}T00:00:00.000Z`);

    const rows = await this.prisma.client.$queryRaw<
      { bucket: number; amount: bigint | null; charges: bigint }[]
    >`
      SELECT bucket,
             COALESCE(SUM("openCents"), 0)::bigint AS "amount",
             COUNT(*)::bigint                      AS "charges"
      FROM (
        SELECT c."openCents",
               CASE
                 WHEN (${asOf}::date - c."dueDate") <= 0  THEN 0
                 WHEN (${asOf}::date - c."dueDate") <= 30 THEN 1
                 WHEN (${asOf}::date - c."dueDate") <= 60 THEN 2
                 WHEN (${asOf}::date - c."dueDate") <= 90 THEN 3
                 ELSE 4
               END AS bucket
        FROM "charges" c
        WHERE c."organizationId" = ${access.organizationId}::uuid
          AND c."openCents" > 0
          AND c."period" <= ${throughPeriod}
          ${scope === null ? Prisma.empty : Prisma.sql`AND c."propertyId" = ANY(${scope}::uuid[])`}
      ) buckets
      GROUP BY bucket
    `;

    const byBucket = new Map(rows.map((row) => [Number(row.bucket), row]));

    return AGING_BUCKETS.map((definition, index) => {
      const row = byBucket.get(index);
      return {
        label: definition.label,
        minDaysPastDue: definition.min,
        maxDaysPastDue: definition.max,
        amountCents: centsFromDb(row?.amount ?? 0n),
        chargeCount: Number(row?.charges ?? 0n),
      };
    });
  }

  /**
   * Share of unreconciled payments that have at least one live suggestion.
   *
   * Measures the engine's reach, not its accuracy: a suggestion the accountant
   * rejects still counts as coverage, because the metric answers "did we give
   * them somewhere to start".
   */
  private async suggestionCoverage(
    access: AccessContext,
    propertyWhere: Record<string, unknown>,
    period: PeriodKey,
  ): Promise<number> {
    const [eligible, covered] = await Promise.all([
      this.prisma.client.bankTransaction.count({
        where: {
          organizationId: access.organizationId,
          ...propertyWhere,
          period,
          direction: 'CREDIT',
          status: { in: ['UNAPPLIED', 'PARTIALLY_ALLOCATED'] },
        },
      }),
      this.prisma.client.bankTransaction.count({
        where: {
          organizationId: access.organizationId,
          ...propertyWhere,
          period,
          direction: 'CREDIT',
          status: { in: ['UNAPPLIED', 'PARTIALLY_ALLOCATED'] },
          suggestions: { some: { status: 'PROPOSED' } },
        },
      }),
    ]);

    return eligible === 0 ? 0 : round4(covered / eligible);
  }

  private async blockerCounts(
    access: AccessContext,
    scope: string[] | null,
    period: PeriodKey,
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.client.reconciliationException.groupBy({
      by: ['propertyId'],
      where: {
        organizationId: access.organizationId,
        ...(scope ? { propertyId: { in: scope } } : {}),
        period,
        isBlocking: true,
        status: { not: 'RESOLVED' },
      },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.propertyId, row._count._all]));
  }

  private async labelOwners(
    access: AccessContext,
    rows: readonly {
      assignedToUserId: string | null;
      _count: { _all: number };
      _sum: { openAmountCents: bigint | null };
    }[],
  ): Promise<ExceptionBucketResult[]> {
    const userIds = rows
      .map((row) => row.assignedToUserId)
      .filter((id): id is string => id !== null);

    const users =
      userIds.length === 0
        ? []
        : await this.prisma.client.user.findMany({
            where: {
              id: { in: userIds },
              memberships: { some: { organizationId: access.organizationId } },
            },
            select: { id: true, displayName: true },
          });
    const nameById = new Map(users.map((user) => [user.id, user.displayName]));

    return rows
      .map((row) => ({
        key: row.assignedToUserId ?? 'unassigned',
        label: row.assignedToUserId
          ? (nameById.get(row.assignedToUserId) ?? 'Unknown user')
          : 'Unassigned',
        count: row._count._all,
        amountCents: centsFromDb(row._sum.openAmountCents),
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * The documented basis of every headline figure.
 *
 * Kept next to the query that produces the numbers so the two cannot drift: if
 * a query changes its date field, this note is the thing that has to change
 * with it.
 */
function buildMetricNotes(
  period: PeriodKey,
  asOfDate: LocalDate,
  scope: string[] | null,
): { metric: string; dateBasis: string; reversalTreatment: string; filters: string }[] {
  const filters =
    scope === null
      ? `organization-wide, period = ${period}`
      : `properties = ${scope.length} selected, period = ${period}`;

  return [
    {
      metric: 'chargesPosted',
      dateBasis: 'charge.period (derived from charge.postingDate)',
      reversalTreatment:
        'Gross amounts. Credit adjustments are reported separately, not netted here.',
      filters,
    },
    {
      metric: 'paymentsReceived',
      dateBasis: 'bankTransaction.period (derived from bankTransaction.postingDate)',
      reversalTreatment: 'Reversed payments are excluded entirely.',
      filters: `${filters}, direction = CREDIT`,
    },
    {
      metric: 'paymentsAllocated',
      dateBasis: 'bankTransaction.period of the payment, not of the allocation',
      reversalTreatment:
        'Reversed allocations are excluded; the running total on the payment is net of them.',
      filters: `${filters}, direction = CREDIT`,
    },
    {
      metric: 'outstandingReceivables',
      dateBasis: `cumulative through ${period}, aged on ${asOfDate}`,
      reversalTreatment:
        'Charge amount less active allocations less credits. Voided charges contribute nothing.',
      filters: `${filters}, cumulative (period <= ${period})`,
    },
    {
      metric: 'unappliedCash',
      dateBasis: `cumulative through ${period}`,
      reversalTreatment:
        'Reversed payments are excluded. Partially allocated payments contribute only their remainder.',
      filters: `${filters}, status in (UNAPPLIED, PARTIALLY_ALLOCATED)`,
    },
    {
      metric: 'allocationRate',
      dateBasis: 'paymentsAllocated / paymentsReceived, both for the period',
      reversalTreatment:
        'Both terms exclude reversed payments, so a reversal does not depress the rate.',
      filters,
    },
    {
      metric: 'suggestionCoverage',
      dateBasis: 'payments in the period that are not fully allocated',
      reversalTreatment: 'Reversed and excluded payments are not eligible.',
      filters: `${filters}, at least one PROPOSED suggestion`,
    },
  ];
}
