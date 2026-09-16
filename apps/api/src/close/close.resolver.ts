import { Args, Context, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { DomainError, type PeriodKey } from '@rentwell/domain';
import type {
  ClosePeriodInput,
  ReopenPeriodInput,
  StartPeriodReviewInput,
} from '@rentwell/graphql';
import { PrismaService } from '../prisma/prisma.service';
import { authorize, resolvePropertyScope } from '../common/guards';
import { toGqlMoney } from '../common/money';
import { memberView, propertyView, type PropertyRowForView } from '../common/view';
import type { GqlContext } from '../common/context';
import { CloseService } from './close.service';
import { centsFromDb } from '@rentwell/database';

@Resolver('CloseReadiness')
export class CloseReadinessResolver {
  constructor(
    private readonly close: CloseService,
    private readonly prisma: PrismaService,
  ) {}

  @Query('closeReadiness')
  async closeReadiness(
    @Args('propertyId') propertyId: string,
    @Args('period') period: PeriodKey,
    @Context() ctx: GqlContext,
  ) {
    const readiness = await this.close.readiness(ctx, propertyId, period);
    const currency = readiness.totals.chargesPosted.currency;

    return {
      propertyId,
      period: readiness.period,
      periodStatus: readiness.periodStatus,
      blockers: readiness.blockers.map((blocker) => ({
        code: blocker.code,
        message: blocker.message,
        count: blocker.count,
        resolutionHint: blocker.resolutionHint,
      })),
      acknowledgements: readiness.acknowledgements.map((item) => ({
        code: item.code,
        message: item.message,
        count: item.count,
        amount: item.amountCents === null ? null : toGqlMoney(item.amountCents, currency),
        requiresReason: item.requiresReason,
      })),
      totals: closeTotalsView(readiness.totals),
      canClose: readiness.canClose,
      evaluatedAt: readiness.evaluatedAt,
    };
  }

  @ResolveField('property')
  async property(@Parent() readiness: { propertyId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.property.load(readiness.propertyId);
    return row ? propertyView(row as unknown as PropertyRowForView) : null;
  }
}

@Resolver('CloseSnapshot')
export class CloseSnapshotResolver {
  constructor(private readonly prisma: PrismaService) {}

  @Query('closeSnapshots')
  async list(
    @Args('propertyId') propertyId: string,
    @Args('first') first: number | null,
    @Context() ctx: GqlContext,
  ) {
    const access = authorize(ctx, 'close_snapshot:read');
    // Throws PROPERTY_NOT_ASSIGNED if this viewer may not see the property,
    // which is the access check for this query.
    resolvePropertyScope(access, [propertyId]);

    const rows = await this.prisma.client.closeSnapshot.findMany({
      where: { propertyId, organizationId: access.organizationId },
      orderBy: { closedAt: 'desc' },
      take: Math.min(first ?? 12, 36),
    });

    return rows.map((row) => closeSnapshotView(row));
  }

  @ResolveField('property')
  async property(@Parent() snapshot: { propertyId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.property.load(snapshot.propertyId);
    return row ? propertyView(row as unknown as PropertyRowForView) : null;
  }

  @ResolveField('closedBy')
  async closedBy(@Parent() snapshot: { closedByUserId: string }, @Context() ctx: GqlContext) {
    return memberView(
      await ctx.loaders.user.load(snapshot.closedByUserId),
      snapshot.closedByUserId,
    );
  }
}

@Resolver('AccountingPeriod')
export class AccountingPeriodResolver {
  constructor(private readonly prisma: PrismaService) {}

  @ResolveField('latestSnapshot')
  async latestSnapshot(@Parent() period: { id: string }) {
    const row = await this.prisma.client.closeSnapshot.findFirst({
      where: { periodId: period.id },
      orderBy: { closedAt: 'desc' },
    });
    return row ? closeSnapshotView(row) : null;
  }
}

@Resolver('Mutation')
export class CloseMutationsResolver {
  constructor(
    private readonly close: CloseService,
    private readonly prisma: PrismaService,
  ) {}

  @Mutation('startPeriodReview')
  async startPeriodReview(
    @Args('input') input: StartPeriodReviewInput,
    @Context() ctx: GqlContext,
  ) {
    const id = await this.close.startReview(ctx, input.propertyId, input.period);
    return this.prisma.client.accountingPeriod.findUniqueOrThrow({ where: { id } });
  }

  @Mutation('closePeriod')
  async closePeriod(@Args('input') input: ClosePeriodInput, @Context() ctx: GqlContext) {
    const { snapshotId } = await this.close.close(ctx, {
      propertyId: input.propertyId,
      period: input.period,
      acknowledgements: input.acknowledgements.map((item) => ({
        code: item.code,
        reason: item.reason ?? null,
      })),
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
    });

    const snapshot = await this.prisma.client.closeSnapshot.findUnique({
      where: { id: snapshotId },
    });
    if (!snapshot) {
      throw new DomainError('INTERNAL_ERROR', 'The close snapshot could not be read back');
    }
    return closeSnapshotView(snapshot);
  }

  @Mutation('reopenPeriod')
  async reopenPeriod(@Args('input') input: ReopenPeriodInput, @Context() ctx: GqlContext) {
    const id = await this.close.reopen(ctx, input);
    return this.prisma.client.accountingPeriod.findUniqueOrThrow({ where: { id } });
  }
}

function closeTotalsView(totals: {
  chargesPosted: { cents: number; currency: string };
  paymentsReceived: { cents: number; currency: string };
  paymentsAllocated: { cents: number; currency: string };
  outstandingReceivables: { cents: number; currency: string };
  unappliedCash: { cents: number; currency: string };
}) {
  return {
    chargesPosted: toGqlMoney(totals.chargesPosted.cents, totals.chargesPosted.currency),
    paymentsReceived: toGqlMoney(totals.paymentsReceived.cents, totals.paymentsReceived.currency),
    paymentsAllocated: toGqlMoney(
      totals.paymentsAllocated.cents,
      totals.paymentsAllocated.currency,
    ),
    outstandingReceivables: toGqlMoney(
      totals.outstandingReceivables.cents,
      totals.outstandingReceivables.currency,
    ),
    unappliedCash: toGqlMoney(totals.unappliedCash.cents, totals.unappliedCash.currency),
  };
}

function closeSnapshotView(row: {
  id: string;
  period: string;
  propertyId: string;
  currency: string;
  chargesPostedCents: bigint | number;
  paymentsReceivedCents: bigint | number;
  paymentsAllocatedCents: bigint | number;
  outstandingCents: bigint | number;
  unappliedCashCents: bigint | number;
  checklist: unknown;
  closedByUserId: string;
  closedAt: Date;
}) {
  const currency = row.currency.trim();
  return {
    id: row.id,
    period: row.period,
    propertyId: row.propertyId,
    closedByUserId: row.closedByUserId,
    closedAt: row.closedAt,
    totals: {
      chargesPosted: toGqlMoney(centsFromDb(row.chargesPostedCents), currency),
      paymentsReceived: toGqlMoney(centsFromDb(row.paymentsReceivedCents), currency),
      paymentsAllocated: toGqlMoney(centsFromDb(row.paymentsAllocatedCents), currency),
      outstandingReceivables: toGqlMoney(centsFromDb(row.outstandingCents), currency),
      unappliedCash: toGqlMoney(centsFromDb(row.unappliedCashCents), currency),
    },
    checklist: Array.isArray(row.checklist) ? row.checklist : [],
  };
}
