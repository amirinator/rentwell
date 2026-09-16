/**
 * Portfolio reads: properties, units, tenants and leases.
 *
 * Every query here starts from the viewer's property scope rather than from an
 * id in the request. A property manager assigned to three buildings issues the
 * same query as a controller and gets three buildings, because the scope is
 * applied in the `where` clause, not filtered out of the results afterwards.
 */

import { Injectable } from '@nestjs/common';
import { DomainError, type AccessContext, type PeriodKey } from '@rentwell/domain';
import { centsFromDb } from '@rentwell/database';
import { clampPageSize } from '@rentwell/graphql';
import { PrismaService } from '../prisma/prisma.service';
import { authorize, authorizeProperty, resolvePropertyScope } from '../common/guards';
import {
  andWhere,
  buildConnection,
  decodeOptionalCursor,
  encodeCursor,
} from '../common/pagination';
import type { GqlContext } from '../common/context';

@Injectable()
export class PortfolioService {
  constructor(private readonly prisma: PrismaService) {}

  async listProperties(
    ctx: GqlContext,
    args: { first?: number | null; after?: string | null; search?: string | null },
  ) {
    const access = authorize(ctx, 'property:read');
    const scope = resolvePropertyScope(access, null);
    const limit = clampPageSize(args.first);
    const cursor = decodeOptionalCursor(args.after);

    // Properties sort by code, which is unique within an organization and
    // stable, so the cursor cannot drift when a property is renamed.
    const where = andWhere(
      { organizationId: access.organizationId },
      scope === null ? undefined : { id: { in: scope } },
      args.search
        ? {
            OR: [
              { code: { contains: args.search, mode: 'insensitive' } },
              { name: { contains: args.search, mode: 'insensitive' } },
              { city: { contains: args.search, mode: 'insensitive' } },
            ],
          }
        : undefined,
      cursor
        ? {
            OR: [
              { code: { gt: cursor.sortValue } },
              { AND: [{ code: cursor.sortValue }, { id: { gt: cursor.id } }] },
            ],
          }
        : undefined,
    );

    const [rows, totalCount] = await Promise.all([
      this.prisma.client.property.findMany({
        where,
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      }),
      this.prisma.client.property.count({
        where: andWhere(
          { organizationId: access.organizationId },
          scope === null ? undefined : { id: { in: scope } },
        ),
      }),
    ]);

    return buildConnection({
      rows,
      limit,
      totalCount,
      hasPreviousPage: cursor !== null,
      cursorFor: (row) => encodeCursor(row.code, row.id),
      toNode: (row) => row,
    });
  }

  async getProperty(ctx: GqlContext, propertyId: string) {
    const property = await this.prisma.client.property.findUnique({ where: { id: propertyId } });
    if (!property) {
      throw new DomainError('NOT_FOUND', 'Property not found', { details: { id: propertyId } });
    }
    authorizeProperty(ctx, 'property:read', property);
    return property;
  }

  // Property card aggregates live in the per-request `propertyStats` loader
  // (see common/loaders.ts), so a list of properties resolves them in one
  // batched pass rather than once per field per row.

  async listUnits(
    ctx: GqlContext,
    propertyId: string,
    args: { first?: number | null; after?: string | null },
  ) {
    const property = await this.getProperty(ctx, propertyId);
    const limit = clampPageSize(args.first);
    const cursor = decodeOptionalCursor(args.after);

    const where = andWhere(
      { propertyId: property.id },
      cursor
        ? {
            OR: [
              { identifier: { gt: cursor.sortValue } },
              { AND: [{ identifier: cursor.sortValue }, { id: { gt: cursor.id } }] },
            ],
          }
        : undefined,
    );

    const [rows, totalCount] = await Promise.all([
      this.prisma.client.unit.findMany({
        where,
        orderBy: [{ identifier: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        include: {
          leases: {
            where: { status: 'ACTIVE' },
            include: { tenant: true },
            orderBy: { termStart: 'desc' },
            take: 1,
          },
        },
      }),
      this.prisma.client.unit.count({ where: { propertyId: property.id } }),
    ]);

    return buildConnection({
      rows,
      limit,
      totalCount,
      hasPreviousPage: cursor !== null,
      cursorFor: (row) => encodeCursor(row.identifier, row.id),
      toNode: (row) => row,
    });
  }

  async getTenant(ctx: GqlContext, tenantId: string) {
    const access = authorize(ctx, 'tenant:read');
    const tenant = await this.prisma.client.tenant.findFirst({
      where: { id: tenantId, organizationId: access.organizationId },
      include: {
        leases: {
          include: { unit: true, property: true },
          orderBy: { termStart: 'desc' },
        },
      },
    });
    if (!tenant) {
      throw new DomainError('NOT_FOUND', 'Tenant not found', { details: { id: tenantId } });
    }

    // A tenant may hold leases across several properties; only the ones the
    // viewer is assigned to are returned.
    const scope = resolvePropertyScope(access, null);
    const leases =
      scope === null
        ? tenant.leases
        : tenant.leases.filter((lease) => scope.includes(lease.propertyId));

    return { ...tenant, leases };
  }

  async tenantBalance(access: AccessContext, tenantId: string): Promise<number> {
    const totals = await this.prisma.client.charge.aggregate({
      where: {
        tenantId,
        organizationId: access.organizationId,
        status: { in: ['POSTED', 'SETTLED'] },
      },
      _sum: { amountCents: true, allocatedCents: true, creditedCents: true },
    });
    return (
      centsFromDb(totals._sum.amountCents) -
      centsFromDb(totals._sum.allocatedCents) -
      centsFromDb(totals._sum.creditedCents)
    );
  }

  async getLease(ctx: GqlContext, leaseId: string) {
    const access = authorize(ctx, 'lease:read');
    const lease = await this.prisma.client.lease.findFirst({
      where: { id: leaseId, organizationId: access.organizationId },
      include: {
        tenant: true,
        unit: true,
        property: true,
        schedules: { include: { versions: { orderBy: { versionNumber: 'asc' } } } },
        amendments: { orderBy: { effectiveOn: 'desc' } },
      },
    });
    if (!lease) {
      throw new DomainError('NOT_FOUND', 'Lease not found', { details: { id: leaseId } });
    }
    authorizeProperty(ctx, 'lease:read', lease.property);
    return lease;
  }

  async leaseBalance(access: AccessContext, leaseId: string): Promise<number> {
    const totals = await this.prisma.client.charge.aggregate({
      where: {
        leaseId,
        organizationId: access.organizationId,
        status: { in: ['POSTED', 'SETTLED'] },
      },
      _sum: { amountCents: true, allocatedCents: true, creditedCents: true },
    });
    return (
      centsFromDb(totals._sum.amountCents) -
      centsFromDb(totals._sum.allocatedCents) -
      centsFromDb(totals._sum.creditedCents)
    );
  }

  async bankAccounts(ctx: GqlContext, propertyId: string) {
    const property = await this.getProperty(ctx, propertyId);
    return this.prisma.client.bankAccount.findMany({
      where: { propertyId: property.id },
      include: { connection: { select: { provider: true, lastSyncedAt: true } } },
      orderBy: { label: 'asc' },
    });
  }

  async accountingPeriod(ctx: GqlContext, propertyId: string, period: PeriodKey) {
    const property = await this.getProperty(ctx, propertyId);
    return this.prisma.client.accountingPeriod.findUnique({
      where: { propertyId_period: { propertyId: property.id, period } },
    });
  }
}
