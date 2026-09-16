/**
 * Shared domain enumerations and value types.
 *
 * These are plain string unions with a matching frozen constant object. The
 * domain package intentionally does not import the Prisma client: the database
 * enums mirror these values, and `packages/database/test/enum-parity.test.ts`
 * fails if the two ever drift apart.
 */

import type { LocalDate, PeriodKey } from './periods/dates';
import type { CurrencyCode, Money } from './money/money';

/**
 * Freezes an enumeration object while preserving its literal member types.
 *
 * The `const` type parameter matters: without it the values widen to `string`,
 * every `type X = (typeof X)[keyof typeof X]` below collapses to `string`, and
 * the compiler stops catching a misspelled status anywhere in the codebase.
 */
function asConst<const T extends Record<string, string>>(value: T): Readonly<T> {
  return Object.freeze(value);
}

// --------------------------------------------------------------------------
// Identity and access
// --------------------------------------------------------------------------

export const Role = asConst({
  ORG_ADMIN: 'ORG_ADMIN',
  PORTFOLIO_CONTROLLER: 'PORTFOLIO_CONTROLLER',
  ACCOUNTANT: 'ACCOUNTANT',
  PROPERTY_MANAGER: 'PROPERTY_MANAGER',
  AUDITOR: 'AUDITOR',
});
export type Role = (typeof Role)[keyof typeof Role];
export const ALL_ROLES: readonly Role[] = Object.values(Role);

export const MembershipStatus = asConst({
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
});
export type MembershipStatus = (typeof MembershipStatus)[keyof typeof MembershipStatus];

// --------------------------------------------------------------------------
// Portfolio
// --------------------------------------------------------------------------

export const PropertyStatus = asConst({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  DISPOSED: 'DISPOSED',
});
export type PropertyStatus = (typeof PropertyStatus)[keyof typeof PropertyStatus];

export const OccupancyStatus = asConst({
  VACANT: 'VACANT',
  OCCUPIED: 'OCCUPIED',
  OUT_OF_SERVICE: 'OUT_OF_SERVICE',
});
export type OccupancyStatus = (typeof OccupancyStatus)[keyof typeof OccupancyStatus];

export const TenantKind = asConst({
  ORGANIZATION: 'ORGANIZATION',
  INDIVIDUAL: 'INDIVIDUAL',
});
export type TenantKind = (typeof TenantKind)[keyof typeof TenantKind];

export const LeaseStatus = asConst({
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  TERMINATED: 'TERMINATED',
});
export type LeaseStatus = (typeof LeaseStatus)[keyof typeof LeaseStatus];

// --------------------------------------------------------------------------
// Billing
// --------------------------------------------------------------------------

export const ChargeType = asConst({
  /** Recurring monthly base rent from the lease schedule. */
  BASE_RENT: 'BASE_RENT',
  /** Recurring fixed operating charge (CAM, insurance, utilities). */
  OPERATING: 'OPERATING',
  /** Non-recurring fee posted once on a stated service date. */
  ONE_TIME: 'ONE_TIME',
});
export type ChargeType = (typeof ChargeType)[keyof typeof ChargeType];

export const ChargeStatus = asConst({
  /** Live receivable. Counts toward outstanding balances and aging. */
  POSTED: 'POSTED',
  /** Fully settled by allocations and/or credits. Retained for history. */
  SETTLED: 'SETTLED',
  /** Fully credited back. Contributes nothing to outstanding receivables. */
  VOIDED: 'VOIDED',
});
export type ChargeStatus = (typeof ChargeStatus)[keyof typeof ChargeStatus];

export const ScheduleFrequency = asConst({
  MONTHLY: 'MONTHLY',
  ONE_TIME: 'ONE_TIME',
});
export type ScheduleFrequency = (typeof ScheduleFrequency)[keyof typeof ScheduleFrequency];

export const ProrationMethod = asConst({
  /** Charge x occupied days / actual days in that calendar month. */
  ACTUAL_DAYS_IN_MONTH: 'ACTUAL_DAYS_IN_MONTH',
  /** Charge x occupied days / 30. Not enabled in version 1. */
  THIRTY_DAY_MONTH: 'THIRTY_DAY_MONTH',
  /** No proration: a partial month bills the full scheduled amount. */
  NONE: 'NONE',
});
export type ProrationMethod = (typeof ProrationMethod)[keyof typeof ProrationMethod];

// --------------------------------------------------------------------------
// Ingestion
// --------------------------------------------------------------------------

export const ImportStatus = asConst({
  DRAFT: 'DRAFT',
  VALIDATING: 'VALIDATING',
  READY: 'READY',
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});
export type ImportStatus = (typeof ImportStatus)[keyof typeof ImportStatus];

/** Statuses from which no further transition is possible. */
export const TERMINAL_IMPORT_STATUSES: readonly ImportStatus[] = [
  ImportStatus.COMPLETED,
  ImportStatus.CANCELLED,
];

export const TransactionSource = asConst({
  CSV_IMPORT: 'CSV_IMPORT',
  PROVIDER_SYNC: 'PROVIDER_SYNC',
  PROVIDER_WEBHOOK: 'PROVIDER_WEBHOOK',
  MANUAL: 'MANUAL',
});
export type TransactionSource = (typeof TransactionSource)[keyof typeof TransactionSource];

export const TransactionStatus = asConst({
  /** Receipt posted, nothing allocated yet. */
  UNAPPLIED: 'UNAPPLIED',
  /** Some but not all of the receipt is allocated. */
  PARTIALLY_ALLOCATED: 'PARTIALLY_ALLOCATED',
  /** Fully allocated against charges. */
  ALLOCATED: 'ALLOCATED',
  /** Provider reversed the payment; allocations and receipt were reversed. */
  REVERSED: 'REVERSED',
  /** Reviewed and deliberately excluded from reconciliation. */
  EXCLUDED: 'EXCLUDED',
});
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

export const TransactionDirection = asConst({
  /** Money into the property account. The only direction reconciled in v1. */
  CREDIT: 'CREDIT',
  /** Money out. Recorded for completeness, never allocated to a charge. */
  DEBIT: 'DEBIT',
});
export type TransactionDirection = (typeof TransactionDirection)[keyof typeof TransactionDirection];

// --------------------------------------------------------------------------
// Reconciliation
// --------------------------------------------------------------------------

export const SuggestionStatus = asConst({
  PROPOSED: 'PROPOSED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  /** Underlying records changed; the suggestion can no longer be approved. */
  SUPERSEDED: 'SUPERSEDED',
});
export type SuggestionStatus = (typeof SuggestionStatus)[keyof typeof SuggestionStatus];

export const MatchStrategy = asConst({
  EXACT_REFERENCE_AND_AMOUNT: 'EXACT_REFERENCE_AND_AMOUNT',
  EXACT_AMOUNT_SINGLE_CHARGE: 'EXACT_AMOUNT_SINGLE_CHARGE',
  REFERENCE_PARTIAL_AMOUNT: 'REFERENCE_PARTIAL_AMOUNT',
  COMBINED_CHARGES: 'COMBINED_CHARGES',
  OVERPAYMENT_WITH_REMAINDER: 'OVERPAYMENT_WITH_REMAINDER',
  DESCRIPTION_HEURISTIC: 'DESCRIPTION_HEURISTIC',
});
export type MatchStrategy = (typeof MatchStrategy)[keyof typeof MatchStrategy];

export const AllocationStatus = asConst({
  ACTIVE: 'ACTIVE',
  REVERSED: 'REVERSED',
});
export type AllocationStatus = (typeof AllocationStatus)[keyof typeof AllocationStatus];

export const ExceptionCategory = asConst({
  MISSING_REFERENCE: 'MISSING_REFERENCE',
  AMBIGUOUS_MATCH: 'AMBIGUOUS_MATCH',
  UNDERPAYMENT: 'UNDERPAYMENT',
  OVERPAYMENT: 'OVERPAYMENT',
  SUSPECTED_DUPLICATE: 'SUSPECTED_DUPLICATE',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  REVERSED_PAYMENT: 'REVERSED_PAYMENT',
  INTEGRATION_CONFLICT: 'INTEGRATION_CONFLICT',
});
export type ExceptionCategory = (typeof ExceptionCategory)[keyof typeof ExceptionCategory];

export const ExceptionStatus = asConst({
  OPEN: 'OPEN',
  ASSIGNED: 'ASSIGNED',
  IN_REVIEW: 'IN_REVIEW',
  RESOLVED: 'RESOLVED',
});
export type ExceptionStatus = (typeof ExceptionStatus)[keyof typeof ExceptionStatus];

export const ExceptionSeverity = asConst({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});
export type ExceptionSeverity = (typeof ExceptionSeverity)[keyof typeof ExceptionSeverity];

export const ExceptionResolution = asConst({
  ALLOCATED: 'ALLOCATED',
  REVERSED: 'REVERSED',
  CREDIT_ISSUED: 'CREDIT_ISSUED',
  CLASSIFIED_UNAPPLIED: 'CLASSIFIED_UNAPPLIED',
  DUPLICATE_CONFIRMED: 'DUPLICATE_CONFIRMED',
  WRITTEN_OFF: 'WRITTEN_OFF',
  NO_ACTION_REQUIRED: 'NO_ACTION_REQUIRED',
});
export type ExceptionResolution = (typeof ExceptionResolution)[keyof typeof ExceptionResolution];

// --------------------------------------------------------------------------
// Accounting
// --------------------------------------------------------------------------

export const LedgerAccountCode = asConst({
  ACCOUNTS_RECEIVABLE: 'ACCOUNTS_RECEIVABLE',
  RENTAL_INCOME: 'RENTAL_INCOME',
  OPERATING_CHARGE_INCOME: 'OPERATING_CHARGE_INCOME',
  CASH_CLEARING: 'CASH_CLEARING',
  UNAPPLIED_CASH: 'UNAPPLIED_CASH',
});
export type LedgerAccountCode = (typeof LedgerAccountCode)[keyof typeof LedgerAccountCode];

export const NormalBalance = asConst({
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
});
export type NormalBalance = (typeof NormalBalance)[keyof typeof NormalBalance];

export const JournalEventType = asConst({
  CHARGE_POSTED: 'CHARGE_POSTED',
  CHARGE_CREDITED: 'CHARGE_CREDITED',
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  PAYMENT_ALLOCATED: 'PAYMENT_ALLOCATED',
  ALLOCATION_REVERSED: 'ALLOCATION_REVERSED',
  PAYMENT_REVERSED: 'PAYMENT_REVERSED',
});
export type JournalEventType = (typeof JournalEventType)[keyof typeof JournalEventType];

export const PeriodStatus = asConst({
  OPEN: 'OPEN',
  IN_REVIEW: 'IN_REVIEW',
  CLOSED: 'CLOSED',
});
export type PeriodStatus = (typeof PeriodStatus)[keyof typeof PeriodStatus];

// --------------------------------------------------------------------------
// Infrastructure
// --------------------------------------------------------------------------

export const OutboxStatus = asConst({
  PENDING: 'PENDING',
  DISPATCHED: 'DISPATCHED',
  FAILED: 'FAILED',
  /** Attempts exhausted. Requires operator inspection and explicit replay. */
  DEAD_LETTER: 'DEAD_LETTER',
});
export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

export const AssistantRunStatus = asConst({
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  /** Exceeded the tool-call or wall-clock budget. */
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
});
export type AssistantRunStatus = (typeof AssistantRunStatus)[keyof typeof AssistantRunStatus];

// --------------------------------------------------------------------------
// Shared value shapes used across modules
// --------------------------------------------------------------------------

/** Identifies which property/period lock a financial operation must hold. */
export interface PeriodRef {
  readonly propertyId: string;
  readonly period: PeriodKey;
}

/** A charge as the reconciliation and close engines need to see it. */
export interface ChargeSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly leaseId: string;
  readonly tenantId: string;
  readonly type: ChargeType;
  readonly status: ChargeStatus;
  readonly currency: CurrencyCode;
  /** Gross amount originally posted. */
  readonly amount: Money;
  /** Total active credits applied against this charge. */
  readonly creditedAmount: Money;
  /** Total currently active allocations against this charge. */
  readonly allocatedAmount: Money;
  readonly serviceStart: LocalDate;
  readonly serviceEnd: LocalDate;
  readonly dueDate: LocalDate;
  readonly period: PeriodKey;
  /** Tenant/lease payment reference printed on invoices. */
  readonly paymentReference: string | null;
  readonly version: number;
}

/** A bank transaction as the reconciliation engine needs to see it. */
export interface TransactionSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly bankAccountId: string;
  readonly status: TransactionStatus;
  readonly direction: TransactionDirection;
  readonly currency: CurrencyCode;
  /** Gross received amount. Always positive for a CREDIT. */
  readonly amount: Money;
  /** Total currently active allocations drawn from this transaction. */
  readonly allocatedAmount: Money;
  readonly postedDate: LocalDate;
  readonly reference: string | null;
  readonly description: string | null;
  readonly version: number;
}

/** Remaining open balance on a charge: amount - credits - active allocations. */
export function chargeOpenBalance(charge: ChargeSnapshot): Money {
  return {
    cents: charge.amount.cents - charge.creditedAmount.cents - charge.allocatedAmount.cents,
    currency: charge.currency,
  };
}

/** Remaining unapplied balance on a transaction: amount - active allocations. */
export function transactionOpenBalance(transaction: TransactionSnapshot): Money {
  return {
    cents: transaction.amount.cents - transaction.allocatedAmount.cents,
    currency: transaction.currency,
  };
}

/** Period reference for a charge, used when acquiring the posting lock. */
export function chargePeriodRef(charge: ChargeSnapshot): PeriodRef {
  return { propertyId: charge.propertyId, period: charge.period };
}
