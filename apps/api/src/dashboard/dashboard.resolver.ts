import { Args, Context, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { clampPageSize, type AuditFilter, type PortfolioFilter } from '@rentwell/graphql';
import { PrismaService } from '../prisma/prisma.service';
import { authorize, resolvePropertyScope } from '../common/guards';
import {
  andWhere,
  buildConnection,
  decodeOptionalCursor,
  encodeCursor,
} from '../common/pagination';
import { toGqlMoney } from '../common/money';
import { propertyView, type PropertyRowForView } from '../common/view';
import type { GqlContext } from '../common/context';
import { DashboardService } from './dashboard.service';

@Resolver('PortfolioSummary')
export class DashboardResolver {
  constructor(private readonly dashboard: DashboardService) {}

  @Query('portfolioSummary')
  async portfolioSummary(@Args('filter') filter: PortfolioFilter, @Context() ctx: GqlContext) {
    const summary = await this.dashboard.summary(ctx, filter);
    const currency = summary.currency;

    return {
      period: summary.period,
      propertyIds: summary.propertyIds,
      chargesPosted: toGqlMoney(summary.chargesPostedCents, currency),
      paymentsReceived: toGqlMoney(summary.paymentsReceivedCents, currency),
      paymentsAllocated: toGqlMoney(summary.paymentsAllocatedCents, currency),
      unappliedCash: toGqlMoney(summary.unappliedCashCents, currency),
      outstandingReceivables: toGqlMoney(summary.outstandingReceivablesCents, currency),
      allocationRate: summary.allocationRate,
      suggestionCoverage: summary.suggestionCoverage,
      aging: summary.aging.map((bucket) => ({
        label: bucket.label,
        // The "current" bucket has no meaningful lower bound; report 0 rather
        // than the sentinel the grouping uses internally.
        minDaysPastDue: Math.max(0, bucket.minDaysPastDue),
        maxDaysPastDue: bucket.maxDaysPastDue,
        amount: toGqlMoney(bucket.amountCents, currency),
        chargeCount: bucket.chargeCount,
      })),
      exceptionsBySeverity: summary.exceptionsBySeverity.map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        count: bucket.count,
        amount: toGqlMoney(bucket.amountCents, currency),
      })),
      exceptionsByOwner: summary.exceptionsByOwner.map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        count: bucket.count,
        amount: toGqlMoney(bucket.amountCents, currency),
      })),
      closeStatus: summary.closeStatus,
      processing: summary.processing,
      asOfDate: summary.asOfDate,
      refreshedAt: summary.refreshedAt,
      metricNotes: summary.metricNotes,
    };
  }
}

@Resolver('PropertyCloseStatus')
export class PropertyCloseStatusResolver {
  @ResolveField('property')
  async property(@Parent() status: { propertyId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.property.load(status.propertyId);
    return row ? propertyView(row as unknown as PropertyRowForView) : null;
  }
}

/**
 * Audit reads.
 *
 * The audit log is the record of who did what, so it is readable by every role
 * that has `audit:read` and is never filtered by anything other than the
 * viewer's organization and property scope. A property manager sees their own
 * properties' history; nobody sees another organization's.
 */
@Resolver('AuditEvent')
export class AuditResolver {
  constructor(private readonly prisma: PrismaService) {}

  @Query('auditEvents')
  async auditEvents(
    @Args('filter') filter: AuditFilter,
    @Args('first') first: number | null,
    @Args('after') after: string | null,
    @Context() ctx: GqlContext,
  ) {
    const access = authorize(ctx, 'audit:read');
    const scope = resolvePropertyScope(access, filter.propertyIds);
    const limit = clampPageSize(first);
    const cursor = decodeOptionalCursor(after);

    const baseWhere = andWhere(
      { organizationId: access.organizationId },
      // Organization-wide events (sign-in, membership changes) have no
      // property, so a scoped viewer sees those plus their own properties'.
      scope === null ? undefined : { OR: [{ propertyId: { in: scope } }, { propertyId: null }] },
      filter.entityType ? { entityType: filter.entityType } : undefined,
      filter.entityId ? { entityId: filter.entityId } : undefined,
      filter.actorUserId ? { actorUserId: filter.actorUserId } : undefined,
      filter.actions && filter.actions.length > 0 ? { action: { in: filter.actions } } : undefined,
      filter.from ? { occurredAt: { gte: new Date(filter.from) } } : undefined,
      filter.to ? { occurredAt: { lte: new Date(filter.to) } } : undefined,
    );

    const where = andWhere(
      baseWhere,
      cursor
        ? {
            OR: [
              { occurredAt: { lt: new Date(cursor.sortValue) } },
              { AND: [{ occurredAt: new Date(cursor.sortValue) }, { id: { lt: cursor.id } }] },
            ],
          }
        : undefined,
    );

    const [rows, totalCount] = await Promise.all([
      this.prisma.client.auditEvent.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: { actor: { select: { displayName: true } } },
      }),
      this.prisma.client.auditEvent.count({ where: baseWhere }),
    ]);

    return buildConnection({
      rows,
      limit,
      totalCount,
      hasPreviousPage: cursor !== null,
      cursorFor: (row) => encodeCursor(row.occurredAt, row.id),
      toNode: (row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        actorName: row.actor?.displayName ?? null,
        actorSystem: row.actorSystem,
        metadata: row.metadata ?? {},
        correlationId: row.correlationId,
        occurredAt: row.occurredAt,
        propertyId: row.propertyId,
      }),
    });
  }

  @ResolveField('property')
  async property(@Parent() event: { propertyId: string | null }, @Context() ctx: GqlContext) {
    if (!event.propertyId) return null;
    const row = await ctx.loaders.property.load(event.propertyId);
    return row ? propertyView(row as unknown as PropertyRowForView) : null;
  }
}
