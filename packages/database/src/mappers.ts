/**
 * Row-to-domain mappers.
 *
 * The domain package knows nothing about Prisma, so every database row crosses
 * this boundary before any rule is applied to it. The row shapes below are
 * declared structurally rather than imported from the generated client, so this
 * file compiles before `prisma generate` has run and stays readable as a
 * description of exactly which columns each rule depends on.
 */

import type { ChargeSnapshot, LocalDate, TransactionSnapshot } from '@rentwell/domain';
import type {
  ChargeStatus,
  ChargeType,
  ScheduleFrequency,
  TransactionDirection,
  TransactionStatus,
} from '@rentwell/domain';
import type { LeaseGenerationInput, ScheduleVersionInput, TenantMatchInfo } from '@rentwell/domain';
import { money } from '@rentwell/domain';
import { centsFromDb } from './money';
import { localDateFromDb, requireLocalDateFromDb } from './dates';

export interface ChargeRow {
  id: string;
  organizationId: string;
  propertyId: string;
  leaseId: string;
  tenantId: string;
  type: string;
  status: string;
  currency: string;
  amountCents: bigint | number;
  allocatedCents: bigint | number;
  creditedCents: bigint | number;
  serviceStart: Date;
  serviceEnd: Date;
  dueDate: Date;
  period: string;
  version: number;
  /** Optional joins used to resolve the payment reference. */
  lease?: {
    paymentReference: string | null;
    tenant?: { paymentReference: string | null } | null;
  } | null;
}

export function toChargeSnapshot(row: ChargeRow): ChargeSnapshot {
  const currency = row.currency.trim();
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    leaseId: row.leaseId,
    tenantId: row.tenantId,
    type: row.type as ChargeType,
    status: row.status as ChargeStatus,
    currency,
    amount: money(centsFromDb(row.amountCents), currency),
    creditedAmount: money(centsFromDb(row.creditedCents), currency),
    allocatedAmount: money(centsFromDb(row.allocatedCents), currency),
    serviceStart: requireLocalDateFromDb(row.serviceStart),
    serviceEnd: requireLocalDateFromDb(row.serviceEnd),
    dueDate: requireLocalDateFromDb(row.dueDate),
    period: row.period,
    paymentReference: row.lease?.paymentReference ?? row.lease?.tenant?.paymentReference ?? null,
    version: row.version,
  };
}

export interface TransactionRow {
  id: string;
  organizationId: string;
  propertyId: string;
  bankAccountId: string;
  status: string;
  direction: string;
  currency: string;
  amountCents: bigint | number;
  allocatedCents: bigint | number;
  postedDate: Date;
  reference: string | null;
  description: string | null;
  version: number;
}

export function toTransactionSnapshot(row: TransactionRow): TransactionSnapshot {
  const currency = row.currency.trim();
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    bankAccountId: row.bankAccountId,
    status: row.status as TransactionStatus,
    direction: row.direction as TransactionDirection,
    currency,
    amount: money(centsFromDb(row.amountCents), currency),
    allocatedAmount: money(centsFromDb(row.allocatedCents), currency),
    postedDate: requireLocalDateFromDb(row.postedDate),
    reference: row.reference,
    description: row.description,
    version: row.version,
  };
}

export interface TenantRow {
  id: string;
  displayName: string;
  paymentReference: string | null;
  leases?: { id: string; paymentReference: string | null }[];
}

export function toTenantMatchInfo(row: TenantRow): TenantMatchInfo {
  return {
    tenantId: row.id,
    displayName: row.displayName,
    paymentReference: row.paymentReference,
    leaseReferences: (row.leases ?? []).map((lease) => ({
      leaseId: lease.id,
      paymentReference: lease.paymentReference,
    })),
  };
}

export function toTenantMatchIndex(rows: readonly TenantRow[]): Map<string, TenantMatchInfo> {
  const index = new Map<string, TenantMatchInfo>();
  for (const row of rows) index.set(row.id, toTenantMatchInfo(row));
  return index;
}

export interface ScheduleVersionRow {
  id: string;
  scheduleId: string;
  versionNumber: number;
  amountCents: bigint | number;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  dueDayOfMonth: number;
  prorate: boolean;
}

export interface ChargeScheduleRow {
  id: string;
  chargeType: string;
  frequency: string;
  description: string;
  isActive: boolean;
  versions: ScheduleVersionRow[];
}

export interface LeaseRow {
  id: string;
  organizationId: string;
  propertyId: string;
  unitId: string;
  tenantId: string;
  status: string;
  currency: string;
  paymentReference: string | null;
  termStart: Date;
  termEnd: Date | null;
  schedules: ChargeScheduleRow[];
  tenant?: { paymentReference: string | null } | null;
}

/**
 * Flattens a lease and its schedule versions into the shape charge generation
 * expects. Inactive schedules are dropped here, so the generator never has to
 * know that a schedule can be switched off.
 */
export function toLeaseGenerationInput(row: LeaseRow): LeaseGenerationInput {
  const schedules: ScheduleVersionInput[] = [];

  for (const schedule of row.schedules) {
    if (!schedule.isActive) continue;
    for (const version of schedule.versions) {
      schedules.push({
        scheduleId: schedule.id,
        scheduleVersionId: version.id,
        versionNumber: version.versionNumber,
        chargeType: schedule.chargeType as ChargeType,
        frequency: schedule.frequency as ScheduleFrequency,
        amount: money(centsFromDb(version.amountCents), version.currency.trim()),
        effectiveFrom: requireLocalDateFromDb(version.effectiveFrom),
        effectiveTo: localDateFromDb(version.effectiveTo),
        dueDayOfMonth: version.dueDayOfMonth,
        prorate: version.prorate,
        description: schedule.description,
      });
    }
  }

  return {
    leaseId: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    unitId: row.unitId,
    tenantId: row.tenantId,
    status: row.status as LeaseGenerationInput['status'],
    currency: row.currency.trim(),
    paymentReference: row.paymentReference ?? row.tenant?.paymentReference ?? null,
    termStart: requireLocalDateFromDb(row.termStart),
    termEnd: localDateFromDb(row.termEnd),
    schedules,
  };
}

/** Narrow helper for `@db.Date` columns that the caller knows are present. */
export function asLocalDate(value: Date): LocalDate {
  return requireLocalDateFromDb(value);
}
