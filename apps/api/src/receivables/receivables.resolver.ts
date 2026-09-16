import { Args, Context, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { DomainError, periodEnd, type LocalDate } from '@rentwell/domain';
import { clampPageSize, type ReceivableFilter } from '@rentwell/graphql';
import { PrismaService } from '../prisma/prisma.service';
import { authorize, resolvePropertyScope } from '../common/guards';
import {
  andWhere,
  buildConnection,
  decodeOptionalCursor,
  encodeCursor,
} from '../common/pagination';
import { toGqlMoney } from '../common/money';
import {
  allocationView,
  chargeView,
  leaseView,
  propertyView,
  type ChargeRowForView,
  type LeaseRowForView,
  type PropertyRowForView,
} from '../common/view';
import type { GqlContext } from '../common/context';
import { ChargesService } from './charges.service';
import { centsFromDb } from '@rentwell/database';

/**
 * Receivables reads and the charge-side mutations.
 *
 * The reporting date (`asOfDate`) is resolved once per request and threaded
 * through every charge on the page, so `daysPastDue` on two rows of the same
 * response is always measured from the same day.
 */
@Resolver('Charge')
export class ChargeResolver {
  constructor(
    private readonly charges: ChargesService,
    private readonly prisma: PrismaService,
  ) {}

  @Query('receivables')
  async receivables(
    @Args('filter') filter: ReceivableFilter,
    @Args('first') first: number | null,
    @Args('after') after: string | null,
    @Context() ctx: GqlContext,
  ) {
    const access = authorize(ctx, 'charge:read');
    const scope = resolvePropertyScope(access, filter.propertyIds);
    const limit = clampPageSize(first);
    const cursor = decodeOptionalCursor(after);
    const asOfDate = filter.asOfDate ?? this.defaultAsOfDate(filter);

    const baseWhere = andWhere(
      { organizationId: access.organizationId },
      scope === null ? undefined : { propertyId: { in: scope } },
      filter.tenantId ? { tenantId: filter.tenantId } : undefined,
      filter.leaseId ? { leaseId: filter.leaseId } : undefined,
      filter.period ? { period: filter.period } : undefined,
      filter.statuses && filter.statuses.length > 0
        ? { status: { in: filter.statuses } }
        : undefined,
      filter.dueBefore
        ? { dueDate: { lt: new Date(`${filter.dueBefore}T00:00:00.000Z`) } }
        : undefined,
      // `openCents` is maintained by every write path, so "still outstanding"
      // is an indexable predicate applied before pagination rather than a
      // filter over rows already fetched — which would give short pages and a
      // wrong `hasNextPage`.
      filter.onlyOutstanding ? { openCents: { gt: 0 } } : undefined,
    );

    const where = andWhere(
      baseWhere,
      cursor
        ? {
            OR: [
              { dueDate: { lt: new Date(`${cursor.sortValue}T00:00:00.000Z`) } },
              {
                AND: [
                  { dueDate: new Date(`${cursor.sortValue}T00:00:00.000Z`) },
                  { id: { lt: cursor.id } },
                ],
              },
            ],
          }
        : undefined,
    );

    const [rows, totalCount, totals] = await Promise.all([
      this.prisma.client.charge.findMany({
        where,
        orderBy: [{ dueDate: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.prisma.client.charge.count({ where: baseWhere }),
      this.charges.totals(access, baseWhere),
    ]);

    const currency = rows[0]?.currency.trim() ?? 'USD';

    const connection = buildConnection({
      rows,
      limit,
      totalCount,
      hasPreviousPage: cursor !== null,
      cursorFor: (row) => encodeCursor(row.dueDate, row.id),
      toNode: (row) => chargeView(row as unknown as ChargeRowForView, asOfDate),
    });

    return {
      ...connection,
      totals: {
        charged: toGqlMoney(totals.charged, currency),
        allocated: toGqlMoney(totals.allocated, currency),
        credited: toGqlMoney(totals.credited, currency),
        outstanding: toGqlMoney(totals.outstanding, currency),
      },
    };
  }

  @Query('charge')
  async charge(@Args('id') id: string, @Context() ctx: GqlContext) {
    const access = authorize(ctx, 'charge:read');
    const row = await this.prisma.client.charge.findFirst({
      where: { id, organizationId: access.organizationId },
    });
    if (!row) throw new DomainError('NOT_FOUND', 'Charge not found', { details: { id } });

    const scope = resolvePropertyScope(access, null);
    if (scope !== null && !scope.includes(row.propertyId)) {
      throw new DomainError('PROPERTY_NOT_ASSIGNED', 'You are not assigned to this property');
    }

    return chargeView(row as unknown as ChargeRowForView, periodEnd(row.period));
  }

  @ResolveField('property')
  async property(@Parent() charge: { propertyId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.property.load(charge.propertyId);
    return row ? propertyView(row as unknown as PropertyRowForView) : null;
  }

  @ResolveField('lease')
  async lease(@Parent() charge: { leaseId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.lease.load(charge.leaseId);
    return row ? leaseView(row as unknown as LeaseRowForView) : null;
  }

  @ResolveField('tenant')
  async tenant(@Parent() charge: { tenantId: string }, @Context() ctx: GqlContext) {
    return ctx.loaders.tenant.load(charge.tenantId);
  }

  @ResolveField('allocations')
  async allocations(@Parent() charge: { id: string }, @Context() ctx: GqlContext) {
    const rows = await ctx.loaders.allocationsByCharge.load(charge.id);
    return rows.map((row) => allocationView(row as never));
  }

  @ResolveField('credits')
  async credits(@Parent() charge: { id: string }) {
    const rows = await this.prisma.client.creditAdjustment.findMany({
      where: { chargeId: charge.id },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      amount: toGqlMoney(centsFromDb(row.amountCents), row.currency.trim()),
      reason: row.reason,
      postingDate: row.postingDate.toISOString().slice(0, 10),
      period: row.period,
      createdAt: row.createdAt,
    }));
  }

  @ResolveField('scheduleVersion')
  async scheduleVersion(@Parent() charge: { scheduleVersionId: string | null }) {
    if (!charge.scheduleVersionId) return null;
    const row = await this.prisma.client.chargeScheduleVersion.findUnique({
      where: { id: charge.scheduleVersionId },
    });
    if (!row) return null;
    return {
      id: row.id,
      versionNumber: row.versionNumber,
      amount: toGqlMoney(centsFromDb(row.amountCents), row.currency.trim()),
      effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
      effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString().slice(0, 10) : null,
      dueDayOfMonth: row.dueDayOfMonth,
      prorate: row.prorate,
      note: row.note,
    };
  }

  /**
   * Aging is measured against the end of the filtered period when one is given,
   * and against today otherwise. Never against "now" when a period was named,
   * because a March report should not change its aging every day of April.
   */
  private defaultAsOfDate(filter: ReceivableFilter): LocalDate {
    if (filter.period) return periodEnd(filter.period);
    return new Date().toISOString().slice(0, 10) as LocalDate;
  }
}

@Resolver('Mutation')
export class ChargeMutationsResolver {
  constructor(
    private readonly charges: ChargesService,
    private readonly prisma: PrismaService,
  ) {}

  @Mutation('previewCharges')
  async previewCharges(
    @Args('input') input: { propertyId: string; period: string },
    @Context() ctx: GqlContext,
  ) {
    const preview = await this.charges.preview(ctx, input.propertyId, input.period);

    return {
      period: preview.period,
      propertyId: preview.propertyId,
      proposed: preview.proposed.map((charge) => ({
        generationKey: charge.generationKey,
        type: charge.type,
        description: charge.description,
        amount: toGqlMoney(charge.amount.cents, charge.currency),
        serviceStart: charge.serviceStart,
        serviceEnd: charge.serviceEnd,
        dueDate: charge.dueDate,
        leaseId: charge.leaseId,
        tenantId: charge.tenantId,
        calculation: charge.calculation,
      })),
      skippedKeys: [...preview.skipped],
      warnings: preview.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
        leaseId: warning.leaseId,
        scheduleId: warning.scheduleId,
      })),
      totalAmount: toGqlMoney(preview.totalAmount.cents, preview.currency),
      leaseCount: preview.leaseCount,
    };
  }

  @Mutation('generateCharges')
  async generateCharges(
    @Args('input')
    input: {
      propertyId: string;
      period: string;
      expectedGenerationKeys: string[];
      idempotencyKey: string;
    },
    @Context() ctx: GqlContext,
  ) {
    const summary = await this.charges.generate(ctx, input);

    const charges = await this.prisma.client.charge.findMany({
      where: { id: { in: summary.chargeIds } },
      orderBy: { dueDate: 'asc' },
    });

    return {
      period: summary.period,
      propertyId: summary.propertyId,
      createdCount: summary.createdCount,
      skippedCount: summary.skippedCount,
      totalAmount: toGqlMoney(summary.totalAmountCents, summary.currency),
      warnings: summary.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
        leaseId: warning.leaseId,
        scheduleId: warning.scheduleId,
      })),
      charges: charges.map((row) =>
        chargeView(row as unknown as ChargeRowForView, periodEnd(summary.period)),
      ),
    };
  }

  @Mutation('createCreditAdjustment')
  async createCreditAdjustment(
    @Args('input')
    input: {
      chargeId: string;
      amount: { cents: number; currency: string };
      reason: string;
      postingDate?: string | null;
      idempotencyKey: string;
    },
    @Context() ctx: GqlContext,
  ) {
    const { chargeId } = await this.charges.createCredit(ctx, {
      chargeId: input.chargeId,
      amountCents: input.amount.cents,
      currency: input.amount.currency,
      reason: input.reason,
      postingDate: (input.postingDate ?? null) as LocalDate | null,
      idempotencyKey: input.idempotencyKey,
    });

    const row = await this.prisma.client.charge.findUniqueOrThrow({ where: { id: chargeId } });
    return chargeView(row as unknown as ChargeRowForView, periodEnd(row.period));
  }
}

/** Proposed charges carry ids rather than embedded records; resolve them lazily. */
@Resolver('ProposedCharge')
export class ProposedChargeResolver {
  @ResolveField('lease')
  async lease(@Parent() proposed: { leaseId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.lease.load(proposed.leaseId);
    return row ? leaseView(row as unknown as LeaseRowForView) : null;
  }

  @ResolveField('tenant')
  async tenant(@Parent() proposed: { tenantId: string }, @Context() ctx: GqlContext) {
    return ctx.loaders.tenant.load(proposed.tenantId);
  }
}
