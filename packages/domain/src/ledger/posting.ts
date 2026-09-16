/**
 * Journal entry construction.
 *
 * Every financial event in Rentwell produces exactly one balanced journal entry
 * through one of the builders below. The builders are pure; the caller writes
 * the returned draft inside the same database transaction as the business
 * change, so a committed allocation can never exist without its posting.
 *
 * Post-once is enforced by `postingEventId`, a deterministic string derived
 * from the business event. The database holds a unique index on
 * (organizationId, postingEventId), so a retried worker, a redelivered outbox
 * event and a double-clicked button all collapse onto the same single entry.
 */

import {
  formatMoney,
  isNegative,
  money,
  zero,
  type CurrencyCode,
  type Money,
} from '../money/money';
import { periodOf, type LocalDate, type PeriodKey } from '../periods/dates';
import {
  JournalEventType,
  LedgerAccountCode,
  type JournalEventType as JournalEventTypeValue,
  type LedgerAccountCode as LedgerAccountCodeValue,
} from '../types';
import { DomainError } from '../errors';
import { incomeAccountForChargeType, signedEffect } from './accounts';

export interface JournalLineDraft {
  readonly accountCode: LedgerAccountCodeValue;
  readonly debit: Money;
  readonly credit: Money;
  readonly memo: string;
  /** Optional dimensions for reporting. Never used for balancing. */
  readonly tenantId?: string | null;
  readonly leaseId?: string | null;
  readonly chargeId?: string | null;
}

export type PostingSourceType =
  'CHARGE' | 'CREDIT_ADJUSTMENT' | 'BANK_TRANSACTION' | 'ALLOCATION' | 'ALLOCATION_REVERSAL';

export interface JournalEntryDraft {
  /** Deterministic identity of the business event. Unique per organization. */
  readonly postingEventId: string;
  readonly eventType: JournalEventTypeValue;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly currency: CurrencyCode;
  /** Date the event is recognised on. Determines the accounting period. */
  readonly postingDate: LocalDate;
  /** Date the event happened in the real world, as reported by the source. */
  readonly businessDate: LocalDate;
  readonly period: PeriodKey;
  readonly description: string;
  readonly sourceType: PostingSourceType;
  readonly sourceId: string;
  /** Set when this entry reverses an earlier one. */
  readonly reversesPostingEventId: string | null;
  readonly lines: readonly JournalLineDraft[];
}

// --------------------------------------------------------------------------
// Line helpers
// --------------------------------------------------------------------------

export function debitLine(
  accountCode: LedgerAccountCodeValue,
  amount: Money,
  memo: string,
  dimensions: Partial<Pick<JournalLineDraft, 'tenantId' | 'leaseId' | 'chargeId'>> = {},
): JournalLineDraft {
  assertNonNegative(amount, accountCode);
  return { accountCode, debit: amount, credit: zero(amount.currency), memo, ...dimensions };
}

export function creditLine(
  accountCode: LedgerAccountCodeValue,
  amount: Money,
  memo: string,
  dimensions: Partial<Pick<JournalLineDraft, 'tenantId' | 'leaseId' | 'chargeId'>> = {},
): JournalLineDraft {
  assertNonNegative(amount, accountCode);
  return { accountCode, debit: zero(amount.currency), credit: amount, memo, ...dimensions };
}

function assertNonNegative(amount: Money, accountCode: LedgerAccountCodeValue): void {
  if (isNegative(amount)) {
    throw new DomainError(
      'UNBALANCED_ENTRY',
      'Journal lines carry positive amounts; direction is expressed by debit or credit, never by sign',
      { details: { accountCode, amountCents: amount.cents } },
    );
  }
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

export interface EntryTotals {
  readonly debit: Money;
  readonly credit: Money;
}

export function entryTotals(
  lines: readonly JournalLineDraft[],
  currency: CurrencyCode,
): EntryTotals {
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    if (line.debit.currency !== currency || line.credit.currency !== currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        'All lines of a journal entry share one currency',
        {
          details: { expected: currency, line: line.accountCode },
        },
      );
    }
    debit += line.debit.cents;
    credit += line.credit.cents;
  }
  return { debit: money(debit, currency), credit: money(credit, currency) };
}

/**
 * Throws unless the entry balances, has at least two lines, and has no line
 * that is simultaneously a debit and a credit.
 */
export function assertBalanced(draft: JournalEntryDraft): void {
  if (draft.lines.length < 2) {
    throw new DomainError('UNBALANCED_ENTRY', 'A journal entry needs at least two lines', {
      details: { postingEventId: draft.postingEventId, lineCount: draft.lines.length },
    });
  }

  for (const line of draft.lines) {
    if (line.debit.cents > 0 && line.credit.cents > 0) {
      throw new DomainError(
        'UNBALANCED_ENTRY',
        'A journal line is either a debit or a credit, not both',
        { details: { postingEventId: draft.postingEventId, accountCode: line.accountCode } },
      );
    }
    if (line.debit.cents === 0 && line.credit.cents === 0) {
      throw new DomainError('UNBALANCED_ENTRY', 'A journal line must carry a non-zero amount', {
        details: { postingEventId: draft.postingEventId, accountCode: line.accountCode },
      });
    }
  }

  const totals = entryTotals(draft.lines, draft.currency);
  if (totals.debit.cents !== totals.credit.cents) {
    throw new DomainError(
      'UNBALANCED_ENTRY',
      `Journal entry does not balance: debits ${formatMoney(totals.debit)} vs credits ${formatMoney(totals.credit)}`,
      {
        details: {
          postingEventId: draft.postingEventId,
          debitCents: totals.debit.cents,
          creditCents: totals.credit.cents,
        },
      },
    );
  }

  if (periodOf(draft.postingDate) !== draft.period) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Posting date ${draft.postingDate} does not fall in period ${draft.period}`,
      { details: { postingEventId: draft.postingEventId } },
    );
  }
}

function finalizeDraft(draft: JournalEntryDraft): JournalEntryDraft {
  assertBalanced(draft);
  return Object.freeze({ ...draft, lines: Object.freeze([...draft.lines]) });
}

// --------------------------------------------------------------------------
// Deterministic posting event identifiers
// --------------------------------------------------------------------------

export function chargePostedEventId(chargeId: string): string {
  return `CHARGE_POSTED:${chargeId}`;
}
export function chargeCreditedEventId(creditAdjustmentId: string): string {
  return `CHARGE_CREDITED:${creditAdjustmentId}`;
}
export function paymentReceivedEventId(transactionId: string): string {
  return `PAYMENT_RECEIVED:${transactionId}`;
}
export function paymentAllocatedEventId(allocationId: string): string {
  return `PAYMENT_ALLOCATED:${allocationId}`;
}
export function allocationReversedEventId(reversalId: string): string {
  return `ALLOCATION_REVERSED:${reversalId}`;
}
export function paymentReversedEventId(transactionId: string): string {
  return `PAYMENT_REVERSED:${transactionId}`;
}

// --------------------------------------------------------------------------
// Builders. One per row of the posting-rules table in the specification.
// --------------------------------------------------------------------------

export interface ChargePostedInput {
  readonly chargeId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly tenantId: string;
  readonly leaseId: string;
  readonly chargeType: string;
  readonly amount: Money;
  readonly postingDate: LocalDate;
  readonly serviceStart: LocalDate;
  readonly description: string;
}

/** Rent or operating charge: debit receivable, credit the income account. */
export function buildChargePostedEntry(input: ChargePostedInput): JournalEntryDraft {
  const incomeAccount = incomeAccountForChargeType(input.chargeType);
  return finalizeDraft({
    postingEventId: chargePostedEventId(input.chargeId),
    eventType: JournalEventType.CHARGE_POSTED,
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    currency: input.amount.currency,
    postingDate: input.postingDate,
    businessDate: input.serviceStart,
    period: periodOf(input.postingDate),
    description: input.description,
    sourceType: 'CHARGE',
    sourceId: input.chargeId,
    reversesPostingEventId: null,
    lines: [
      debitLine(LedgerAccountCode.ACCOUNTS_RECEIVABLE, input.amount, input.description, {
        tenantId: input.tenantId,
        leaseId: input.leaseId,
        chargeId: input.chargeId,
      }),
      creditLine(incomeAccount, input.amount, input.description, {
        tenantId: input.tenantId,
        leaseId: input.leaseId,
        chargeId: input.chargeId,
      }),
    ],
  });
}

export interface ChargeCreditedInput {
  readonly creditAdjustmentId: string;
  readonly chargeId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly tenantId: string;
  readonly leaseId: string;
  readonly chargeType: string;
  readonly amount: Money;
  readonly postingDate: LocalDate;
  readonly reason: string;
}

/** Credit adjustment: debit the income account back, credit the receivable. */
export function buildChargeCreditedEntry(input: ChargeCreditedInput): JournalEntryDraft {
  const incomeAccount = incomeAccountForChargeType(input.chargeType);
  const memo = `Credit adjustment: ${input.reason}`;
  return finalizeDraft({
    postingEventId: chargeCreditedEventId(input.creditAdjustmentId),
    eventType: JournalEventType.CHARGE_CREDITED,
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    currency: input.amount.currency,
    postingDate: input.postingDate,
    businessDate: input.postingDate,
    period: periodOf(input.postingDate),
    description: memo,
    sourceType: 'CREDIT_ADJUSTMENT',
    sourceId: input.creditAdjustmentId,
    reversesPostingEventId: chargePostedEventId(input.chargeId),
    lines: [
      debitLine(incomeAccount, input.amount, memo, {
        tenantId: input.tenantId,
        leaseId: input.leaseId,
        chargeId: input.chargeId,
      }),
      creditLine(LedgerAccountCode.ACCOUNTS_RECEIVABLE, input.amount, memo, {
        tenantId: input.tenantId,
        leaseId: input.leaseId,
        chargeId: input.chargeId,
      }),
    ],
  });
}

export interface PaymentReceivedInput {
  readonly transactionId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly amount: Money;
  readonly postingDate: LocalDate;
  readonly valueDate: LocalDate;
  readonly description: string;
}

/**
 * Payment receipt: debit cash clearing, credit unapplied cash.
 *
 * Received money is a liability to the tenant until it is matched to a charge,
 * so it lands in unapplied cash rather than reducing receivables directly.
 */
export function buildPaymentReceivedEntry(input: PaymentReceivedInput): JournalEntryDraft {
  return finalizeDraft({
    postingEventId: paymentReceivedEventId(input.transactionId),
    eventType: JournalEventType.PAYMENT_RECEIVED,
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    currency: input.amount.currency,
    postingDate: input.postingDate,
    businessDate: input.valueDate,
    period: periodOf(input.postingDate),
    description: input.description,
    sourceType: 'BANK_TRANSACTION',
    sourceId: input.transactionId,
    reversesPostingEventId: null,
    lines: [
      debitLine(LedgerAccountCode.CASH_CLEARING, input.amount, input.description),
      creditLine(LedgerAccountCode.UNAPPLIED_CASH, input.amount, input.description),
    ],
  });
}

export interface PaymentAllocatedInput {
  readonly allocationId: string;
  readonly transactionId: string;
  readonly chargeId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly tenantId: string;
  readonly leaseId: string;
  readonly amount: Money;
  readonly postingDate: LocalDate;
  readonly description: string;
}

/** Allocation: debit unapplied cash, credit accounts receivable. */
export function buildPaymentAllocatedEntry(input: PaymentAllocatedInput): JournalEntryDraft {
  return finalizeDraft({
    postingEventId: paymentAllocatedEventId(input.allocationId),
    eventType: JournalEventType.PAYMENT_ALLOCATED,
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    currency: input.amount.currency,
    postingDate: input.postingDate,
    businessDate: input.postingDate,
    period: periodOf(input.postingDate),
    description: input.description,
    sourceType: 'ALLOCATION',
    sourceId: input.allocationId,
    reversesPostingEventId: null,
    lines: [
      debitLine(LedgerAccountCode.UNAPPLIED_CASH, input.amount, input.description, {
        tenantId: input.tenantId,
        leaseId: input.leaseId,
        chargeId: input.chargeId,
      }),
      creditLine(LedgerAccountCode.ACCOUNTS_RECEIVABLE, input.amount, input.description, {
        tenantId: input.tenantId,
        leaseId: input.leaseId,
        chargeId: input.chargeId,
      }),
    ],
  });
}

export interface AllocationReversedInput {
  readonly reversalId: string;
  readonly allocationId: string;
  readonly transactionId: string;
  readonly chargeId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly tenantId: string;
  readonly leaseId: string;
  readonly amount: Money;
  readonly postingDate: LocalDate;
  readonly reason: string;
}

/**
 * Allocation reversal: the exact opposite of the allocation entry, posted as a
 * new compensating entry. The original is never edited or deleted.
 */
export function buildAllocationReversedEntry(input: AllocationReversedInput): JournalEntryDraft {
  const memo = `Allocation reversed: ${input.reason}`;
  return finalizeDraft({
    postingEventId: allocationReversedEventId(input.reversalId),
    eventType: JournalEventType.ALLOCATION_REVERSED,
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    currency: input.amount.currency,
    postingDate: input.postingDate,
    businessDate: input.postingDate,
    period: periodOf(input.postingDate),
    description: memo,
    sourceType: 'ALLOCATION_REVERSAL',
    sourceId: input.reversalId,
    reversesPostingEventId: paymentAllocatedEventId(input.allocationId),
    lines: [
      debitLine(LedgerAccountCode.ACCOUNTS_RECEIVABLE, input.amount, memo, {
        tenantId: input.tenantId,
        leaseId: input.leaseId,
        chargeId: input.chargeId,
      }),
      creditLine(LedgerAccountCode.UNAPPLIED_CASH, input.amount, memo, {
        tenantId: input.tenantId,
        leaseId: input.leaseId,
        chargeId: input.chargeId,
      }),
    ],
  });
}

export interface PaymentReversedInput {
  readonly transactionId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly amount: Money;
  readonly postingDate: LocalDate;
  readonly reason: string;
}

/**
 * Payment reversal: credit cash clearing, debit unapplied cash.
 *
 * Only valid once every allocation drawn from the payment has been reversed,
 * which the reconciliation service checks before calling this. Reversing the
 * receipt while allocations are live would leave unapplied cash negative.
 */
export function buildPaymentReversedEntry(input: PaymentReversedInput): JournalEntryDraft {
  const memo = `Payment reversed: ${input.reason}`;
  return finalizeDraft({
    postingEventId: paymentReversedEventId(input.transactionId),
    eventType: JournalEventType.PAYMENT_REVERSED,
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    currency: input.amount.currency,
    postingDate: input.postingDate,
    businessDate: input.postingDate,
    period: periodOf(input.postingDate),
    description: memo,
    sourceType: 'BANK_TRANSACTION',
    sourceId: input.transactionId,
    reversesPostingEventId: paymentReceivedEventId(input.transactionId),
    lines: [
      debitLine(LedgerAccountCode.UNAPPLIED_CASH, input.amount, memo),
      creditLine(LedgerAccountCode.CASH_CLEARING, input.amount, memo),
    ],
  });
}

// --------------------------------------------------------------------------
// Balance derivation
// --------------------------------------------------------------------------

export interface PostedLine {
  readonly accountCode: LedgerAccountCodeValue;
  readonly debitCents: number;
  readonly creditCents: number;
}

export type AccountBalances = Readonly<Record<string, number>>;

/**
 * Folds posted lines into per-account balances expressed in each account's own
 * normal-balance direction, so a positive receivable balance means money owed.
 */
export function deriveAccountBalances(lines: readonly PostedLine[]): AccountBalances {
  const balances: Record<string, number> = {};
  for (const account of Object.values(LedgerAccountCode)) balances[account] = 0;
  for (const line of lines) {
    balances[line.accountCode] =
      (balances[line.accountCode] ?? 0) +
      signedEffect(line.accountCode, line.debitCents, line.creditCents);
  }
  return Object.freeze(balances);
}

/**
 * Total debits minus total credits across a set of lines. Must be zero for any
 * complete set of entries; used by the close checklist and by integration tests
 * to prove the subledger is internally consistent.
 */
export function netDebitMinusCredit(lines: readonly PostedLine[]): number {
  let net = 0;
  for (const line of lines) net += line.debitCents - line.creditCents;
  return net;
}
