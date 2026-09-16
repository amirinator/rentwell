import { Args, Context, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import type { PeriodKey } from '@rentwell/domain';
import { PrismaService } from '../prisma/prisma.service';
import { principal } from '../common/guards';
import { toGqlMoney } from '../common/money';
import {
  leaseView,
  propertyView,
  scheduleVersionView,
  type LeaseRowForView,
  type PropertyRowForView,
} from '../common/view';
import type { GqlContext } from '../common/context';
import { PortfolioService } from './portfolio.service';

/**
 * Portfolio queries and the field resolvers for the types they return.
 *
 * Relations and aggregates are deferred to field resolvers so a list of 25
 * properties does not compute 25 sets of balances unless the client asked for
 * them. Everything scalar is already on the parent payload.
 */
@Resolver('Property')
export class PropertyResolver {
  constructor(private readonly portfolio: PortfolioService) {}

  @Query('properties')
  async properties(
    @Args('first') first: number | null,
    @Args('after') after: string | null,
    @Args('search') search: string | null,
    @Context() ctx: GqlContext,
  ) {
    const connection = await this.portfolio.listProperties(ctx, { first, after, search });
    return {
      ...connection,
      edges: connection.edges.map((edge) => ({
        cursor: edge.cursor,
        node: propertyView(edge.node as PropertyRowForView),
      })),
    };
  }

  @Query('property')
  async property(@Args('id') id: string, @Context() ctx: GqlContext) {
    return propertyView((await this.portfolio.getProperty(ctx, id)) as PropertyRowForView);
  }

  // The five fields below all come from one batched loader result, so asking
  // for all of them costs the same as asking for one.

  @ResolveField('unitCount')
  async unitCount(@Parent() property: { id: string }, @Context() ctx: GqlContext) {
    return (await ctx.loaders.propertyStats.load(property.id)).unitCount;
  }

  @ResolveField('activeLeaseCount')
  async activeLeaseCount(@Parent() property: { id: string }, @Context() ctx: GqlContext) {
    return (await ctx.loaders.propertyStats.load(property.id)).activeLeaseCount;
  }

  @ResolveField('outstandingReceivables')
  async outstandingReceivables(
    @Parent() property: { id: string; currency: string },
    @Context() ctx: GqlContext,
  ) {
    const stats = await ctx.loaders.propertyStats.load(property.id);
    return toGqlMoney(stats.outstandingCents, property.currency);
  }

  @ResolveField('unappliedCash')
  async unappliedCash(
    @Parent() property: { id: string; currency: string },
    @Context() ctx: GqlContext,
  ) {
    const stats = await ctx.loaders.propertyStats.load(property.id);
    return toGqlMoney(stats.unappliedCashCents, property.currency);
  }

  @ResolveField('openExceptionCount')
  async openExceptionCount(@Parent() property: { id: string }, @Context() ctx: GqlContext) {
    return (await ctx.loaders.propertyStats.load(property.id)).openExceptionCount;
  }

  @ResolveField('units')
  async units(
    @Parent() property: { id: string },
    @Args('first') first: number | null,
    @Args('after') after: string | null,
    @Context() ctx: GqlContext,
  ) {
    return this.portfolio.listUnits(ctx, property.id, { first, after });
  }

  @ResolveField('bankAccounts')
  async bankAccounts(@Parent() property: { id: string }, @Context() ctx: GqlContext) {
    const rows = await this.portfolio.bankAccounts(ctx, property.id);
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      maskedNumber: row.maskedNumber,
      currency: row.currency.trim(),
      isActive: row.isActive,
      propertyId: row.propertyId,
      provider: row.connection?.provider ?? null,
      lastSyncedAt: row.connection?.lastSyncedAt ?? null,
    }));
  }

  @ResolveField('period')
  async period(
    @Parent() property: { id: string },
    @Args('period') period: PeriodKey,
    @Context() ctx: GqlContext,
  ) {
    return this.portfolio.accountingPeriod(ctx, property.id, period);
  }
}

@Resolver('Unit')
export class UnitResolver {
  constructor(private readonly prisma: PrismaService) {}

  @ResolveField('property')
  async property(@Parent() unit: { propertyId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.property.load(unit.propertyId);
    return row ? propertyView(row as unknown as PropertyRowForView) : null;
  }

  @ResolveField('currentLease')
  async currentLease(@Parent() unit: { id: string; leases?: LeaseRowForView[] }) {
    // The unit list query already loaded the active lease, so this is free
    // there; a unit fetched on its own pays for one query.
    const preloaded = (unit.leases ?? [])[0];
    if (preloaded) return leaseView(preloaded);

    const lease = await this.prisma.client.lease.findFirst({
      where: { unitId: unit.id, status: 'ACTIVE' },
      orderBy: { termStart: 'desc' },
    });
    return lease ? leaseView(lease) : null;
  }
}

@Resolver('Tenant')
export class TenantResolver {
  constructor(private readonly portfolio: PortfolioService) {}

  @Query('tenant')
  async tenant(@Args('id') id: string, @Context() ctx: GqlContext) {
    const row = await this.portfolio.getTenant(ctx, id);
    return {
      id: row.id,
      displayName: row.displayName,
      kind: row.kind,
      contactEmail: row.contactEmail,
      contactPhone: row.contactPhone,
      paymentReference: row.paymentReference,
      isActive: row.isActive,
      leases: row.leases.map((lease) => leaseView(lease)),
    };
  }

  @ResolveField('outstandingBalance')
  async outstandingBalance(@Parent() tenant: { id: string }, @Context() ctx: GqlContext) {
    const access = principal(ctx);
    const cents = await this.portfolio.tenantBalance(access, tenant.id);
    return toGqlMoney(cents, 'USD');
  }
}

@Resolver('Lease')
export class LeaseResolver {
  constructor(private readonly portfolio: PortfolioService) {}

  @Query('lease')
  async lease(@Args('id') id: string, @Context() ctx: GqlContext) {
    const row = await this.portfolio.getLease(ctx, id);
    return {
      ...leaseView(row),
      schedules: row.schedules.map((schedule) => ({
        id: schedule.id,
        chargeType: schedule.chargeType,
        frequency: schedule.frequency,
        description: schedule.description,
        isActive: schedule.isActive,
        versions: schedule.versions.map((version) => scheduleVersionView(version)),
      })),
      amendments: row.amendments.map((amendment) => ({
        id: amendment.id,
        summary: amendment.summary,
        changes: amendment.changes ?? {},
        effectiveOn: amendment.effectiveOn.toISOString().slice(0, 10),
        createdAt: amendment.createdAt,
      })),
    };
  }

  @ResolveField('property')
  async property(@Parent() lease: { propertyId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.property.load(lease.propertyId);
    return row ? propertyView(row as unknown as PropertyRowForView) : null;
  }

  @ResolveField('tenant')
  async tenant(@Parent() lease: { tenantId: string }, @Context() ctx: GqlContext) {
    return ctx.loaders.tenant.load(lease.tenantId);
  }

  @ResolveField('unit')
  async unit(@Parent() lease: { unitId: string }, @Context() ctx: GqlContext) {
    return ctx.loaders.unit.load(lease.unitId);
  }

  @ResolveField('outstandingBalance')
  async outstandingBalance(
    @Parent() lease: { id: string; currency: string },
    @Context() ctx: GqlContext,
  ) {
    const access = principal(ctx);
    const cents = await this.portfolio.leaseBalance(access, lease.id);
    return toGqlMoney(cents, lease.currency ?? 'USD');
  }
}

@Resolver('ChargeSchedule')
export class ChargeScheduleResolver {
  @ResolveField('effectiveVersion')
  effectiveVersion(
    @Parent() schedule: { versions: { effectiveFrom: string; effectiveTo: string | null }[] },
    @Args('on') on: string,
  ) {
    // Versions arrive ordered by version number; the effective one is the
    // latest whose range contains the date, which is the same rule charge
    // generation applies.
    const matching = schedule.versions.filter(
      (version) =>
        version.effectiveFrom <= on && (version.effectiveTo === null || version.effectiveTo >= on),
    );
    return matching.length > 0 ? matching[matching.length - 1] : null;
  }
}
