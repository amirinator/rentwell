import { describe, expect, it } from 'vitest';
import {
  fillChargesInOrder,
  nextChargeStatus,
  nextTransactionStatus,
  planAllocation,
  planReversal,
  totalOfLines,
} from '../src/allocation/allocation';
import { ChargeStatus, TransactionStatus } from '../src/types';
import { charge, expectDomainError, transaction, usd } from './helpers';

describe('planAllocation', () => {
  it('accepts a single line that exactly settles one charge', () => {
    const plan = planAllocation({
      transaction: transaction({ id: 'txn_1', amount: usd(100_000) }),
      charges: [charge({ id: 'chg_1', amount: usd(100_000) })],
      lines: [{ chargeId: 'chg_1', amount: usd(100_000) }],
    });

    expect(plan.totalAllocated.cents).toBe(100_000);
    expect(plan.remainingUnapplied.cents).toBe(0);
    expect(plan.fullyApplied).toBe(true);
    expect(plan.resultingChargeBalances.get('chg_1')!.cents).toBe(0);
  });

  it('spreads one payment across several charges', () => {
    const plan = planAllocation({
      transaction: transaction({ id: 'txn_1', amount: usd(150_000) }),
      charges: [
        charge({ id: 'chg_1', amount: usd(100_000) }),
        charge({ id: 'chg_2', amount: usd(50_000) }),
      ],
      lines: [
        { chargeId: 'chg_1', amount: usd(100_000) },
        { chargeId: 'chg_2', amount: usd(50_000) },
      ],
    });

    expect(plan.totalAllocated.cents).toBe(150_000);
    expect(plan.remainingUnapplied.cents).toBe(0);
  });

  it('leaves an overpayment as unapplied cash rather than over-allocating', () => {
    const plan = planAllocation({
      transaction: transaction({ id: 'txn_1', amount: usd(120_000) }),
      charges: [charge({ id: 'chg_1', amount: usd(100_000) })],
      lines: [{ chargeId: 'chg_1', amount: usd(100_000) }],
    });

    expect(plan.remainingUnapplied.cents).toBe(20_000);
    expect(plan.fullyApplied).toBe(false);
  });

  it('refuses to allocate more than the charge still owes', () => {
    expectDomainError(
      () =>
        planAllocation({
          transaction: transaction({ id: 'txn_1', amount: usd(150_000) }),
          charges: [charge({ id: 'chg_1', amount: usd(100_000), allocatedAmount: usd(40_000) })],
          lines: [{ chargeId: 'chg_1', amount: usd(70_000) }],
        }),
      'INSUFFICIENT_CHARGE_BALANCE',
    );
  });

  it('folds duplicate lines for one charge before the balance check', () => {
    // Two half-lines must not slip past a limit that a single line would fail.
    expectDomainError(
      () =>
        planAllocation({
          transaction: transaction({ id: 'txn_1', amount: usd(200_000) }),
          charges: [charge({ id: 'chg_1', amount: usd(100_000) })],
          lines: [
            { chargeId: 'chg_1', amount: usd(60_000) },
            { chargeId: 'chg_1', amount: usd(60_000) },
          ],
        }),
      'INSUFFICIENT_CHARGE_BALANCE',
    );
  });

  it('refuses to allocate more than the payment still has available', () => {
    expectDomainError(
      () =>
        planAllocation({
          transaction: transaction({
            id: 'txn_1',
            amount: usd(100_000),
            allocatedAmount: usd(60_000),
          }),
          charges: [charge({ id: 'chg_1', amount: usd(100_000) })],
          lines: [{ chargeId: 'chg_1', amount: usd(50_000) }],
        }),
      'INSUFFICIENT_PAYMENT_BALANCE',
    );
  });

  it('rejects a zero or negative line', () => {
    const txn = transaction({ id: 'txn_1' });
    const chg = charge({ id: 'chg_1' });
    expectDomainError(
      () =>
        planAllocation({
          transaction: txn,
          charges: [chg],
          lines: [{ chargeId: 'chg_1', amount: usd(0) }],
        }),
      'VALIDATION_FAILED',
    );
    expectDomainError(
      () =>
        planAllocation({
          transaction: txn,
          charges: [chg],
          lines: [{ chargeId: 'chg_1', amount: usd(-1) }],
        }),
      'VALIDATION_FAILED',
    );
  });

  it('rejects an empty line set', () => {
    expectDomainError(
      () => planAllocation({ transaction: transaction({ id: 'txn_1' }), charges: [], lines: [] }),
      'VALIDATION_FAILED',
    );
  });

  it('rejects a reference to a charge that was not supplied', () => {
    expectDomainError(
      () =>
        planAllocation({
          transaction: transaction({ id: 'txn_1' }),
          charges: [],
          lines: [{ chargeId: 'chg_missing', amount: usd(100) }],
        }),
      'NOT_FOUND',
    );
  });

  it('rejects a cross-property allocation', () => {
    expectDomainError(
      () =>
        planAllocation({
          transaction: transaction({ id: 'txn_1', propertyId: 'prop_1' }),
          charges: [charge({ id: 'chg_1', propertyId: 'prop_2' })],
          lines: [{ chargeId: 'chg_1', amount: usd(1000) }],
        }),
      'CROSS_PROPERTY_ALLOCATION',
    );
  });

  it('rejects a cross-organization allocation', () => {
    expectDomainError(
      () =>
        planAllocation({
          transaction: transaction({ id: 'txn_1', organizationId: 'org_1' }),
          charges: [charge({ id: 'chg_1', organizationId: 'org_2' })],
          lines: [{ chargeId: 'chg_1', amount: usd(1000) }],
        }),
      'ORGANIZATION_MISMATCH',
    );
  });

  it('rejects a cross-currency allocation', () => {
    expectDomainError(
      () =>
        planAllocation({
          transaction: transaction({ id: 'txn_1', currency: 'USD' }),
          charges: [charge({ id: 'chg_1', currency: 'EUR' })],
          lines: [{ chargeId: 'chg_1', amount: usd(1000) }],
        }),
      'CURRENCY_MISMATCH',
    );
  });

  it('refuses to allocate a reversed payment', () => {
    expectDomainError(
      () =>
        planAllocation({
          transaction: transaction({ id: 'txn_1', status: TransactionStatus.REVERSED }),
          charges: [charge({ id: 'chg_1' })],
          lines: [{ chargeId: 'chg_1', amount: usd(1000) }],
        }),
      'CONFLICT',
    );
  });

  it('refuses to allocate to a voided charge', () => {
    expectDomainError(
      () =>
        planAllocation({
          transaction: transaction({ id: 'txn_1' }),
          charges: [
            charge({ id: 'chg_1', status: ChargeStatus.VOIDED, creditedAmount: usd(100_000) }),
          ],
          lines: [{ chargeId: 'chg_1', amount: usd(1000) }],
        }),
      'CONFLICT',
    );
  });

  it('refuses to allocate an outgoing (debit) transaction', () => {
    expectDomainError(
      () =>
        planAllocation({
          transaction: transaction({ id: 'txn_1', direction: 'DEBIT' }),
          charges: [charge({ id: 'chg_1' })],
          lines: [{ chargeId: 'chg_1', amount: usd(1000) }],
        }),
      'VALIDATION_FAILED',
    );
  });

  it('treats credits as reducing what a charge can receive', () => {
    const txn = transaction({ id: 'txn_1', amount: usd(100_000) });
    const chg = charge({ id: 'chg_1', amount: usd(100_000), creditedAmount: usd(30_000) });

    expectDomainError(
      () =>
        planAllocation({
          transaction: txn,
          charges: [chg],
          lines: [{ chargeId: 'chg_1', amount: usd(80_000) }],
        }),
      'INSUFFICIENT_CHARGE_BALANCE',
    );

    const plan = planAllocation({
      transaction: txn,
      charges: [chg],
      lines: [{ chargeId: 'chg_1', amount: usd(70_000) }],
    });
    expect(plan.resultingChargeBalances.get('chg_1')!.cents).toBe(0);
  });
});

describe('derived statuses', () => {
  it('reports the transaction status implied by its allocated total', () => {
    const txn = transaction({ id: 'txn_1', amount: usd(100_000) });
    expect(nextTransactionStatus(txn, usd(0))).toBe(TransactionStatus.UNAPPLIED);
    expect(nextTransactionStatus(txn, usd(40_000))).toBe(TransactionStatus.PARTIALLY_ALLOCATED);
    expect(nextTransactionStatus(txn, usd(100_000))).toBe(TransactionStatus.ALLOCATED);
  });

  it('keeps a reversed transaction reversed', () => {
    const txn = transaction({ id: 'txn_1', status: TransactionStatus.REVERSED });
    expect(nextTransactionStatus(txn, usd(0))).toBe(TransactionStatus.REVERSED);
  });

  it('reports the charge status implied by allocations and credits', () => {
    const chg = charge({ id: 'chg_1', amount: usd(100_000) });
    expect(nextChargeStatus(chg, usd(0), usd(0))).toBe(ChargeStatus.POSTED);
    expect(nextChargeStatus(chg, usd(60_000), usd(0))).toBe(ChargeStatus.POSTED);
    expect(nextChargeStatus(chg, usd(60_000), usd(40_000))).toBe(ChargeStatus.SETTLED);
    expect(nextChargeStatus(chg, usd(0), usd(100_000))).toBe(ChargeStatus.VOIDED);
  });
});

describe('planReversal', () => {
  it('unwinds a full allocation and recomputes both statuses', () => {
    const plan = planReversal({
      allocationId: 'alloc_1',
      allocationStatus: 'ACTIVE',
      allocatedAmount: usd(100_000),
      transaction: transaction({
        id: 'txn_1',
        amount: usd(100_000),
        allocatedAmount: usd(100_000),
        status: TransactionStatus.ALLOCATED,
      }),
      charge: charge({ id: 'chg_1', amount: usd(100_000), allocatedAmount: usd(100_000) }),
    });

    expect(plan.reversedAmount.cents).toBe(100_000);
    expect(plan.transactionAllocatedAfter.cents).toBe(0);
    expect(plan.chargeAllocatedAfter.cents).toBe(0);
    expect(plan.transactionStatusAfter).toBe(TransactionStatus.UNAPPLIED);
    expect(plan.chargeStatusAfter).toBe(ChargeStatus.POSTED);
  });

  it('refuses to reverse an allocation twice', () => {
    expectDomainError(
      () =>
        planReversal({
          allocationId: 'alloc_1',
          allocationStatus: 'REVERSED',
          allocatedAmount: usd(100),
          transaction: transaction({ id: 'txn_1' }),
          charge: charge({ id: 'chg_1' }),
        }),
      'ALLOCATION_ALREADY_REVERSED',
    );
  });

  it('refuses a reversal that would drive a total negative', () => {
    expectDomainError(
      () =>
        planReversal({
          allocationId: 'alloc_1',
          allocationStatus: 'ACTIVE',
          allocatedAmount: usd(100_000),
          transaction: transaction({ id: 'txn_1', allocatedAmount: usd(10_000) }),
          charge: charge({ id: 'chg_1', allocatedAmount: usd(10_000) }),
        }),
      'CONFLICT',
    );
  });
});

describe('fillChargesInOrder', () => {
  it('fills charges in the order given until the payment runs out', () => {
    const lines = fillChargesInOrder(usd(100_000), [
      charge({ id: 'chg_1', amount: usd(60_000) }),
      charge({ id: 'chg_2', amount: usd(60_000) }),
      charge({ id: 'chg_3', amount: usd(60_000) }),
    ]);

    expect(lines.map((line) => [line.chargeId, line.amount.cents])).toEqual([
      ['chg_1', 60_000],
      ['chg_2', 40_000],
    ]);
    expect(totalOfLines(lines, 'USD').cents).toBe(100_000);
  });

  it('skips charges with no open balance', () => {
    const lines = fillChargesInOrder(usd(20_000), [
      charge({ id: 'chg_1', amount: usd(50_000), allocatedAmount: usd(50_000) }),
      charge({ id: 'chg_2', amount: usd(50_000) }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.chargeId).toBe('chg_2');
  });

  it('returns nothing when there is no money to apply', () => {
    expect(fillChargesInOrder(usd(0), [charge({ id: 'chg_1' })])).toEqual([]);
    expect(totalOfLines([], 'USD').cents).toBe(0);
  });
});
