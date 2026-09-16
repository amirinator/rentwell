import { describe, expect, it } from 'vitest';
import {
  assertBalanced,
  buildAllocationReversedEntry,
  buildChargeCreditedEntry,
  buildChargePostedEntry,
  buildPaymentAllocatedEntry,
  buildPaymentReceivedEntry,
  buildPaymentReversedEntry,
  creditLine,
  debitLine,
  deriveAccountBalances,
  entryTotals,
  netDebitMinusCredit,
  type JournalEntryDraft,
  type PostedLine,
} from '../src/ledger/posting';
import { LEDGER_ACCOUNTS, incomeAccountForChargeType, signedEffect } from '../src/ledger/accounts';
import { JournalEventType, LedgerAccountCode } from '../src/types';
import { expectDomainError, usd } from './helpers';

const BASE = {
  organizationId: 'org_1',
  propertyId: 'prop_1',
  tenantId: 'tenant_1',
  leaseId: 'lease_1',
};

function linesOf(draft: JournalEntryDraft): PostedLine[] {
  return draft.lines.map((line) => ({
    accountCode: line.accountCode,
    debitCents: line.debit.cents,
    creditCents: line.credit.cents,
  }));
}

describe('chart of accounts', () => {
  it('defines exactly the five subledger accounts', () => {
    expect(LEDGER_ACCOUNTS.map((account) => account.code).sort()).toEqual([
      'ACCOUNTS_RECEIVABLE',
      'CASH_CLEARING',
      'OPERATING_CHARGE_INCOME',
      'RENTAL_INCOME',
      'UNAPPLIED_CASH',
    ]);
  });

  it('routes each charge type to its income account', () => {
    expect(incomeAccountForChargeType('BASE_RENT')).toBe(LedgerAccountCode.RENTAL_INCOME);
    expect(incomeAccountForChargeType('OPERATING')).toBe(LedgerAccountCode.OPERATING_CHARGE_INCOME);
    expect(incomeAccountForChargeType('ONE_TIME')).toBe(LedgerAccountCode.OPERATING_CHARGE_INCOME);
  });

  it('expresses balances in each account own normal direction', () => {
    // Receivable is debit-normal: a debit increases what tenants owe.
    expect(signedEffect(LedgerAccountCode.ACCOUNTS_RECEIVABLE, 1000, 0)).toBe(1000);
    // Unapplied cash is credit-normal: a credit increases the liability.
    expect(signedEffect(LedgerAccountCode.UNAPPLIED_CASH, 0, 1000)).toBe(1000);
    expect(signedEffect(LedgerAccountCode.UNAPPLIED_CASH, 1000, 0)).toBe(-1000);
  });
});

describe('posting builders', () => {
  it('posts a rent charge as receivable debit and rental income credit', () => {
    const entry = buildChargePostedEntry({
      ...BASE,
      chargeId: 'chg_1',
      chargeType: 'BASE_RENT',
      amount: usd(310_000),
      postingDate: '2026-03-01',
      serviceStart: '2026-03-01',
      description: 'March base rent',
    });

    expect(entry.postingEventId).toBe('CHARGE_POSTED:chg_1');
    expect(entry.eventType).toBe(JournalEventType.CHARGE_POSTED);
    expect(entry.period).toBe('2026-03');
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines[0]!.accountCode).toBe(LedgerAccountCode.ACCOUNTS_RECEIVABLE);
    expect(entry.lines[0]!.debit.cents).toBe(310_000);
    expect(entry.lines[1]!.accountCode).toBe(LedgerAccountCode.RENTAL_INCOME);
    expect(entry.lines[1]!.credit.cents).toBe(310_000);
    expect(netDebitMinusCredit(linesOf(entry))).toBe(0);
  });

  it('posts an operating charge to the operating income account', () => {
    const entry = buildChargePostedEntry({
      ...BASE,
      chargeId: 'chg_2',
      chargeType: 'OPERATING',
      amount: usd(45_000),
      postingDate: '2026-03-01',
      serviceStart: '2026-03-01',
      description: 'March CAM',
    });
    expect(entry.lines[1]!.accountCode).toBe(LedgerAccountCode.OPERATING_CHARGE_INCOME);
  });

  it('posts a payment receipt to cash clearing and unapplied cash', () => {
    const entry = buildPaymentReceivedEntry({
      organizationId: 'org_1',
      propertyId: 'prop_1',
      transactionId: 'txn_1',
      amount: usd(100_000),
      postingDate: '2026-03-05',
      valueDate: '2026-03-04',
      description: 'ACH receipt',
    });

    expect(entry.postingEventId).toBe('PAYMENT_RECEIVED:txn_1');
    expect(entry.businessDate).toBe('2026-03-04');
    expect(entry.postingDate).toBe('2026-03-05');
    expect(entry.lines[0]!.accountCode).toBe(LedgerAccountCode.CASH_CLEARING);
    expect(entry.lines[0]!.debit.cents).toBe(100_000);
    expect(entry.lines[1]!.accountCode).toBe(LedgerAccountCode.UNAPPLIED_CASH);
    expect(entry.lines[1]!.credit.cents).toBe(100_000);
  });

  it('moves an allocation from unapplied cash to receivable', () => {
    const entry = buildPaymentAllocatedEntry({
      ...BASE,
      allocationId: 'alloc_1',
      transactionId: 'txn_1',
      chargeId: 'chg_1',
      amount: usd(100_000),
      postingDate: '2026-03-05',
      description: 'Allocation to March rent',
    });

    expect(entry.postingEventId).toBe('PAYMENT_ALLOCATED:alloc_1');
    expect(entry.lines[0]!.accountCode).toBe(LedgerAccountCode.UNAPPLIED_CASH);
    expect(entry.lines[0]!.debit.cents).toBe(100_000);
    expect(entry.lines[1]!.accountCode).toBe(LedgerAccountCode.ACCOUNTS_RECEIVABLE);
    expect(entry.lines[1]!.credit.cents).toBe(100_000);
  });

  it('reverses an allocation with the exact opposite entry, linked to the original', () => {
    const original = buildPaymentAllocatedEntry({
      ...BASE,
      allocationId: 'alloc_1',
      transactionId: 'txn_1',
      chargeId: 'chg_1',
      amount: usd(100_000),
      postingDate: '2026-03-05',
      description: 'Allocation',
    });
    const reversal = buildAllocationReversedEntry({
      ...BASE,
      reversalId: 'rev_1',
      allocationId: 'alloc_1',
      transactionId: 'txn_1',
      chargeId: 'chg_1',
      amount: usd(100_000),
      postingDate: '2026-03-09',
      reason: 'Applied to the wrong invoice',
    });

    expect(reversal.reversesPostingEventId).toBe(original.postingEventId);
    expect(reversal.eventType).toBe(JournalEventType.ALLOCATION_REVERSED);

    // The two entries together leave every account exactly where it started.
    const combined = deriveAccountBalances([...linesOf(original), ...linesOf(reversal)]);
    expect(combined[LedgerAccountCode.UNAPPLIED_CASH]).toBe(0);
    expect(combined[LedgerAccountCode.ACCOUNTS_RECEIVABLE]).toBe(0);
  });

  it('credits a charge back against its own income account', () => {
    const entry = buildChargeCreditedEntry({
      ...BASE,
      creditAdjustmentId: 'cr_1',
      chargeId: 'chg_1',
      chargeType: 'BASE_RENT',
      amount: usd(50_000),
      postingDate: '2026-03-20',
      reason: 'Agreed rent abatement',
    });

    expect(entry.postingEventId).toBe('CHARGE_CREDITED:cr_1');
    expect(entry.reversesPostingEventId).toBe('CHARGE_POSTED:chg_1');
    expect(entry.lines[0]!.accountCode).toBe(LedgerAccountCode.RENTAL_INCOME);
    expect(entry.lines[0]!.debit.cents).toBe(50_000);
    expect(entry.lines[1]!.accountCode).toBe(LedgerAccountCode.ACCOUNTS_RECEIVABLE);
    expect(entry.lines[1]!.credit.cents).toBe(50_000);
  });

  it('reverses a receipt by unwinding cash clearing and unapplied cash', () => {
    const entry = buildPaymentReversedEntry({
      organizationId: 'org_1',
      propertyId: 'prop_1',
      transactionId: 'txn_1',
      amount: usd(100_000),
      postingDate: '2026-03-12',
      reason: 'Provider returned the payment',
    });
    expect(entry.reversesPostingEventId).toBe('PAYMENT_RECEIVED:txn_1');
    expect(entry.lines[0]!.accountCode).toBe(LedgerAccountCode.UNAPPLIED_CASH);
    expect(entry.lines[0]!.debit.cents).toBe(100_000);
    expect(entry.lines[1]!.accountCode).toBe(LedgerAccountCode.CASH_CLEARING);
  });
});

describe('entry validation', () => {
  const skeleton = {
    postingEventId: 'TEST:1',
    eventType: JournalEventType.CHARGE_POSTED,
    organizationId: 'org_1',
    propertyId: 'prop_1',
    currency: 'USD',
    postingDate: '2026-03-01',
    businessDate: '2026-03-01',
    period: '2026-03',
    description: 'test',
    sourceType: 'CHARGE' as const,
    sourceId: 'chg_1',
    reversesPostingEventId: null,
  };

  it('rejects an unbalanced entry', () => {
    expectDomainError(
      () =>
        assertBalanced({
          ...skeleton,
          lines: [
            debitLine(LedgerAccountCode.ACCOUNTS_RECEIVABLE, usd(1000), 'x'),
            creditLine(LedgerAccountCode.RENTAL_INCOME, usd(999), 'x'),
          ],
        }),
      'UNBALANCED_ENTRY',
    );
  });

  it('rejects a single-line entry', () => {
    expectDomainError(
      () =>
        assertBalanced({
          ...skeleton,
          lines: [debitLine(LedgerAccountCode.ACCOUNTS_RECEIVABLE, usd(1000), 'x')],
        }),
      'UNBALANCED_ENTRY',
    );
  });

  it('rejects a zero-amount line', () => {
    expectDomainError(
      () =>
        assertBalanced({
          ...skeleton,
          lines: [
            debitLine(LedgerAccountCode.ACCOUNTS_RECEIVABLE, usd(0), 'x'),
            creditLine(LedgerAccountCode.RENTAL_INCOME, usd(0), 'x'),
          ],
        }),
      'UNBALANCED_ENTRY',
    );
  });

  it('rejects a negative line amount: direction is debit or credit, never sign', () => {
    expectDomainError(
      () => debitLine(LedgerAccountCode.ACCOUNTS_RECEIVABLE, usd(-100), 'x'),
      'UNBALANCED_ENTRY',
    );
  });

  it('rejects a posting date outside its stated period', () => {
    expectDomainError(
      () =>
        assertBalanced({
          ...skeleton,
          postingDate: '2026-04-01',
          lines: [
            debitLine(LedgerAccountCode.ACCOUNTS_RECEIVABLE, usd(1000), 'x'),
            creditLine(LedgerAccountCode.RENTAL_INCOME, usd(1000), 'x'),
          ],
        }),
      'VALIDATION_FAILED',
    );
  });

  it('totals debits and credits', () => {
    const totals = entryTotals(
      [
        debitLine(LedgerAccountCode.ACCOUNTS_RECEIVABLE, usd(1000), 'x'),
        creditLine(LedgerAccountCode.RENTAL_INCOME, usd(600), 'x'),
        creditLine(LedgerAccountCode.OPERATING_CHARGE_INCOME, usd(400), 'x'),
      ],
      'USD',
    );
    expect(totals.debit.cents).toBe(1000);
    expect(totals.credit.cents).toBe(1000);
  });
});

describe('the full lifecycle of one charge and its payment', () => {
  it('leaves receivables and unapplied cash at zero once settled', () => {
    const charged = buildChargePostedEntry({
      ...BASE,
      chargeId: 'chg_1',
      chargeType: 'BASE_RENT',
      amount: usd(310_000),
      postingDate: '2026-03-01',
      serviceStart: '2026-03-01',
      description: 'March rent',
    });
    const received = buildPaymentReceivedEntry({
      organizationId: 'org_1',
      propertyId: 'prop_1',
      transactionId: 'txn_1',
      amount: usd(310_000),
      postingDate: '2026-03-04',
      valueDate: '2026-03-04',
      description: 'ACH',
    });
    const allocated = buildPaymentAllocatedEntry({
      ...BASE,
      allocationId: 'alloc_1',
      transactionId: 'txn_1',
      chargeId: 'chg_1',
      amount: usd(310_000),
      postingDate: '2026-03-04',
      description: 'Allocation',
    });

    const all = [...linesOf(charged), ...linesOf(received), ...linesOf(allocated)];
    const balances = deriveAccountBalances(all);

    expect(netDebitMinusCredit(all)).toBe(0);
    expect(balances[LedgerAccountCode.ACCOUNTS_RECEIVABLE]).toBe(0);
    expect(balances[LedgerAccountCode.UNAPPLIED_CASH]).toBe(0);
    // Income was earned and the cash arrived; both stay on the books.
    expect(balances[LedgerAccountCode.RENTAL_INCOME]).toBe(310_000);
    expect(balances[LedgerAccountCode.CASH_CLEARING]).toBe(310_000);
  });

  it('leaves an overpayment sitting in unapplied cash', () => {
    const charged = buildChargePostedEntry({
      ...BASE,
      chargeId: 'chg_1',
      chargeType: 'BASE_RENT',
      amount: usd(100_000),
      postingDate: '2026-03-01',
      serviceStart: '2026-03-01',
      description: 'March rent',
    });
    const received = buildPaymentReceivedEntry({
      organizationId: 'org_1',
      propertyId: 'prop_1',
      transactionId: 'txn_1',
      amount: usd(150_000),
      postingDate: '2026-03-04',
      valueDate: '2026-03-04',
      description: 'ACH',
    });
    const allocated = buildPaymentAllocatedEntry({
      ...BASE,
      allocationId: 'alloc_1',
      transactionId: 'txn_1',
      chargeId: 'chg_1',
      amount: usd(100_000),
      postingDate: '2026-03-04',
      description: 'Allocation',
    });

    const balances = deriveAccountBalances([
      ...linesOf(charged),
      ...linesOf(received),
      ...linesOf(allocated),
    ]);
    expect(balances[LedgerAccountCode.ACCOUNTS_RECEIVABLE]).toBe(0);
    expect(balances[LedgerAccountCode.UNAPPLIED_CASH]).toBe(50_000);
  });
});
