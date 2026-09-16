/**
 * Row-to-GraphQL mappers.
 *
 * Resolvers return fully-shaped objects built here rather than leaning on field
 * resolvers for every scalar. Two reasons: a `Money` is always constructed from
 * cents plus currency in one place, so a formatted string can never disagree
 * with the value it claims to show; and a reviewer can read one function to see
 * exactly which columns a GraphQL type exposes.
 *
 * Field resolvers are still used, but only where the work is expensive enough
 * to be worth deferring until the client actually asks — relations and
 * aggregates, not scalars the row already carries.
 */

import { chargeOpenBalance, daysBetween, type LocalDate } from '@rentwell/domain';
import { centsFromDb, localDateFromDb, requireLocalDateFromDb } from '@rentwell/database';
import { toGqlMoney } from './money';

/** Serializes a `@db.Date` column for the Date scalar. */
export function dateOut(value: Date): LocalDate {
  return requireLocalDateFromDb(value);
}

export function optionalDateOut(value: Date | null): LocalDate | null {
  return localDateFromDb(value);
}

// --------------------------------------------------------------------------
// Charges
// --------------------------------------------------------------------------

export interface ChargeRowForView {
  id: string;
  type: string;
  status: string;
  description: string;
  currency: string;
  amountCents: bigint | number;
  allocatedCents: bigint | number;
  creditedCents: bigint | number;
  serviceStart: Date;
  serviceEnd: Date;
  dueDate: Date;
  postingDate: Date;
  period: string;
  calculation: unknown;
  version: number;
  propertyId: string;
  leaseId: string;
  tenantId: string;
  scheduleVersionId: string | null;
}

/**
 * Shapes a charge for the API.
 *
 * `asOfDate` drives `daysPastDue`. It is always supplied by the caller from the
 * request's reporting date rather than read from the clock here, so two fields
 * on the same response cannot be aged against two different instants.
 */
export function chargeView(row: ChargeRowForView, asOfDate: LocalDate) {
  const currency = row.currency.trim();
  const amount = centsFromDb(row.amountCents);
  const allocated = centsFromDb(row.allocatedCents);
  const credited = centsFromDb(row.creditedCents);
  const dueDate = dateOut(row.dueDate);
  const open = amount - allocated - credited;
  const daysPastDue = Math.max(0, daysBetween(dueDate, asOfDate));

  return {
    id: row.id,
    type: row.type,
    status: row.status,
    description: row.description,
    amount: toGqlMoney(amount, currency),
    allocatedAmount: toGqlMoney(allocated, currency),
    creditedAmount: toGqlMoney(credited, currency),
    openBalance: toGqlMoney(open, currency),
    serviceStart: dateOut(row.serviceStart),
    serviceEnd: dateOut(row.serviceEnd),
    dueDate,
    postingDate: dateOut(row.postingDate),
    period: row.period,
    daysPastDue: open > 0 ? daysPastDue : 0,
    calculation: row.calculation ?? {},
    version: row.version,
    // Ids are kept on the payload so field resolvers can load relations
    // without a second fetch of the parent row.
    propertyId: row.propertyId,
    leaseId: row.leaseId,
    tenantId: row.tenantId,
    scheduleVersionId: row.scheduleVersionId,
  };
}

/** Open balance of a charge row, in cents. */
export function openBalanceCents(row: {
  currency: string;
  amountCents: bigint | number;
  allocatedCents: bigint | number;
  creditedCents: bigint | number;
}): number {
  return (
    centsFromDb(row.amountCents) - centsFromDb(row.allocatedCents) - centsFromDb(row.creditedCents)
  );
}

// --------------------------------------------------------------------------
// Transactions
// --------------------------------------------------------------------------

export interface TransactionRowForView {
  id: string;
  source: string;
  externalId: string;
  direction: string;
  status: string;
  currency: string;
  amountCents: bigint | number;
  allocatedCents: bigint | number;
  postedDate: Date;
  postingDate: Date;
  period: string;
  reference: string | null;
  description: string | null;
  reversedAt: Date | null;
  reversalReason: string | null;
  version: number;
  propertyId: string;
  bankAccountId: string;
}

export function transactionView(row: TransactionRowForView) {
  const currency = row.currency.trim();
  const amount = centsFromDb(row.amountCents);
  const allocated = centsFromDb(row.allocatedCents);

  return {
    id: row.id,
    source: row.source,
    externalId: row.externalId,
    direction: row.direction,
    status: row.status,
    amount: toGqlMoney(amount, currency),
    allocatedAmount: toGqlMoney(allocated, currency),
    unappliedAmount: toGqlMoney(amount - allocated, currency),
    postedDate: dateOut(row.postedDate),
    postingDate: dateOut(row.postingDate),
    period: row.period,
    reference: row.reference,
    description: row.description,
    reversedAt: row.reversedAt,
    reversalReason: row.reversalReason,
    version: row.version,
    propertyId: row.propertyId,
    bankAccountId: row.bankAccountId,
  };
}

// --------------------------------------------------------------------------
// Properties, units, tenants, leases
// --------------------------------------------------------------------------

export interface PropertyRowForView {
  id: string;
  code: string;
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  timezone: string;
  currency: string;
  status: string;
}

export function propertyView(row: PropertyRowForView) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    countryCode: row.countryCode,
    timezone: row.timezone,
    currency: row.currency.trim(),
    status: row.status,
  };
}

export interface LeaseRowForView {
  id: string;
  reference: string;
  status: string;
  currency: string;
  termStart: Date;
  termEnd: Date | null;
  paymentReference: string | null;
  version: number;
  propertyId: string;
  unitId: string;
  tenantId: string;
}

export function leaseView(row: LeaseRowForView) {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    currency: row.currency.trim(),
    termStart: dateOut(row.termStart),
    termEnd: optionalDateOut(row.termEnd),
    paymentReference: row.paymentReference,
    version: row.version,
    propertyId: row.propertyId,
    unitId: row.unitId,
    tenantId: row.tenantId,
  };
}

export function scheduleVersionView(row: {
  id: string;
  versionNumber: number;
  amountCents: bigint | number;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  dueDayOfMonth: number;
  prorate: boolean;
  note: string | null;
}) {
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    amount: toGqlMoney(centsFromDb(row.amountCents), row.currency.trim()),
    effectiveFrom: dateOut(row.effectiveFrom),
    effectiveTo: optionalDateOut(row.effectiveTo),
    dueDayOfMonth: row.dueDayOfMonth,
    prorate: row.prorate,
    note: row.note,
  };
}

// --------------------------------------------------------------------------
// Allocations, exceptions, journal
// --------------------------------------------------------------------------

export function allocationView(row: {
  id: string;
  amountCents: bigint | number;
  currency: string;
  status: string;
  postingDate: Date;
  period: string;
  note: string | null;
  chargeId: string;
  transactionId: string;
  approvedByUserId: string;
  approvedAt: Date;
}) {
  return {
    id: row.id,
    amount: toGqlMoney(centsFromDb(row.amountCents), row.currency.trim()),
    status: row.status,
    postingDate: dateOut(row.postingDate),
    period: row.period,
    note: row.note,
    chargeId: row.chargeId,
    transactionId: row.transactionId,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt,
  };
}

export function exceptionView(row: {
  id: string;
  category: string;
  status: string;
  severity: string;
  summary: string;
  isBlocking: boolean;
  openAmountCents: bigint | number;
  currency: string;
  period: string;
  propertyId: string;
  transactionId: string | null;
  tenantId: string | null;
  assignedToUserId: string | null;
  resolution: string | null;
  resolutionReason: string | null;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  reopenCount: number;
  createdAt: Date;
  version: number;
}) {
  return {
    id: row.id,
    category: row.category,
    status: row.status,
    severity: row.severity,
    summary: row.summary,
    isBlocking: row.isBlocking,
    openAmount: toGqlMoney(centsFromDb(row.openAmountCents), row.currency.trim()),
    period: row.period,
    propertyId: row.propertyId,
    transactionId: row.transactionId,
    tenantId: row.tenantId,
    assignedToUserId: row.assignedToUserId,
    resolution: row.resolution,
    resolutionReason: row.resolutionReason,
    resolvedByUserId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt,
    reopenCount: row.reopenCount,
    createdAt: row.createdAt,
    version: row.version,
  };
}

export function journalEntryView(row: {
  id: string;
  postingEventId: string;
  eventType: string;
  description: string;
  currency: string;
  postingDate: Date;
  businessDate: Date;
  period: string;
  totalDebitCents: bigint | number;
  totalCreditCents: bigint | number;
  sourceType: string;
  sourceId: string;
  reversesPostingEventId: string | null;
  createdAt: Date;
  propertyId: string;
  lines?: {
    id: string;
    accountCode: string;
    debitCents: bigint | number;
    creditCents: bigint | number;
    memo: string;
    chargeId: string | null;
    tenantId: string | null;
  }[];
}) {
  const currency = row.currency.trim();
  return {
    id: row.id,
    postingEventId: row.postingEventId,
    eventType: row.eventType,
    description: row.description,
    postingDate: dateOut(row.postingDate),
    businessDate: dateOut(row.businessDate),
    period: row.period,
    totalDebit: toGqlMoney(centsFromDb(row.totalDebitCents), currency),
    totalCredit: toGqlMoney(centsFromDb(row.totalCreditCents), currency),
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    reversesPostingEventId: row.reversesPostingEventId,
    createdAt: row.createdAt,
    propertyId: row.propertyId,
    lines: (row.lines ?? []).map((line) => ({
      id: line.id,
      accountCode: line.accountCode,
      debit: toGqlMoney(centsFromDb(line.debitCents), currency),
      credit: toGqlMoney(centsFromDb(line.creditCents), currency),
      memo: line.memo,
      chargeId: line.chargeId,
      tenantId: line.tenantId,
    })),
  };
}

// --------------------------------------------------------------------------
// People
// --------------------------------------------------------------------------

/**
 * Shapes a user loaded through the per-request user loader as an
 * `OrganizationMember`.
 *
 * Returns null rather than a placeholder when the row is missing, because the
 * only reason it would be missing is that the user belongs to another
 * organization — and inventing a name or a role for them would misstate who
 * approved or was assigned something.
 */
export function memberView(row: Record<string, unknown> | null, userId: string) {
  if (!row) return null;
  return {
    id: (row.membershipId as string | null) ?? userId,
    userId,
    email: row.email as string,
    displayName: row.displayName as string,
    role: (row.role as string | null) ?? 'UNKNOWN',
    status: (row.membershipStatus as string | null) ?? 'UNKNOWN',
    assignedProperties: [],
  };
}

/** Re-exported so resolvers can compute an open balance without a second import. */
export { chargeOpenBalance };
