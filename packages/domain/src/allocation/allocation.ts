/**
 * Allocation rules.
 *
 * An allocation moves a stated amount from a received payment onto one charge.
 * These functions are the single place that decides whether a proposed set of
 * allocations is legal. The API calls them again inside the approval
 * transaction, against freshly locked rows, so a suggestion built minutes ago
 * cannot commit against balances that have since changed.
 *
 * Invariants enforced here:
 *   1. Every line is positive and denominated in the transaction's currency.
 *   2. The sum of lines never exceeds the transaction's unapplied balance.
 *   3. No single charge receives more than its remaining open balance.
 *   4. Payment and charges belong to the same organization and property.
 *   5. A reversed or excluded transaction allocates nothing.
 */

import {
  add,
  compareMoney,
  formatMoney,
  isPositive,
  money,
  subtract,
  sum,
  zero,
  type Money,
} from '../money/money';
import {
  ChargeStatus,
  TransactionDirection,
  TransactionStatus,
  chargeOpenBalance,
  transactionOpenBalance,
  type ChargeSnapshot,
  type TransactionSnapshot,
} from '../types';
import { DomainError } from '../errors';

/** One proposed movement of funds from a payment onto a charge. */
export interface AllocationLine {
  readonly chargeId: string;
  readonly amount: Money;
}

export interface AllocationValidationInput {
  readonly transaction: TransactionSnapshot;
  /** Charges referenced by the lines, keyed by id by the caller. */
  readonly charges: readonly ChargeSnapshot[];
  readonly lines: readonly AllocationLine[];
}

export interface AllocationPlan {
  readonly lines: readonly AllocationLine[];
  readonly totalAllocated: Money;
  /** Payment amount left unapplied after this plan commits. */
  readonly remainingUnapplied: Money;
  /** Per-charge open balance after this plan commits. */
  readonly resultingChargeBalances: ReadonlyMap<string, Money>;
  /** True when the payment is fully consumed by this plan. */
  readonly fullyApplied: boolean;
}

function indexCharges(charges: readonly ChargeSnapshot[]): Map<string, ChargeSnapshot> {
  const index = new Map<string, ChargeSnapshot>();
  for (const charge of charges) index.set(charge.id, charge);
  return index;
}

/**
 * Validates a proposed allocation set and returns the resulting balances.
 * Throws a DomainError on the first violation; the caller surfaces its `code`.
 */
export function planAllocation(input: AllocationValidationInput): AllocationPlan {
  const { transaction, lines } = input;
  const chargeIndex = indexCharges(input.charges);

  if (lines.length === 0) {
    throw new DomainError('VALIDATION_FAILED', 'An allocation must contain at least one line');
  }

  if (transaction.direction !== TransactionDirection.CREDIT) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Only incoming (credit) transactions can be allocated to charges',
      { details: { transactionId: transaction.id, direction: transaction.direction } },
    );
  }

  if (
    transaction.status === TransactionStatus.REVERSED ||
    transaction.status === TransactionStatus.EXCLUDED
  ) {
    throw new DomainError(
      'CONFLICT',
      `Transaction is ${transaction.status} and cannot receive new allocations`,
      { details: { transactionId: transaction.id, status: transaction.status } },
    );
  }

  const seenCharges = new Set<string>();
  const perChargeTotal = new Map<string, Money>();

  for (const line of lines) {
    if (line.amount.currency !== transaction.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `Allocation line is in ${line.amount.currency} but the payment is in ${transaction.currency}`,
        { details: { chargeId: line.chargeId, transactionId: transaction.id } },
      );
    }
    if (!isPositive(line.amount)) {
      throw new DomainError('VALIDATION_FAILED', 'Allocation amounts must be greater than zero', {
        details: { chargeId: line.chargeId, amount: line.amount.cents },
      });
    }

    const charge = chargeIndex.get(line.chargeId);
    if (!charge) {
      throw new DomainError('NOT_FOUND', 'Charge referenced by an allocation line was not found', {
        details: { chargeId: line.chargeId },
      });
    }

    if (charge.organizationId !== transaction.organizationId) {
      throw new DomainError(
        'ORGANIZATION_MISMATCH',
        'Payment and charge belong to different organizations',
        { details: { chargeId: charge.id, transactionId: transaction.id } },
      );
    }
    if (charge.propertyId !== transaction.propertyId) {
      throw new DomainError(
        'CROSS_PROPERTY_ALLOCATION',
        'Version 1 does not allocate a payment across properties',
        {
          details: {
            chargeId: charge.id,
            chargePropertyId: charge.propertyId,
            transactionPropertyId: transaction.propertyId,
          },
        },
      );
    }
    if (charge.currency !== transaction.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `Charge is in ${charge.currency} but the payment is in ${transaction.currency}`,
        { details: { chargeId: charge.id, transactionId: transaction.id } },
      );
    }
    if (charge.status === ChargeStatus.VOIDED) {
      throw new DomainError('CONFLICT', 'A voided charge cannot receive an allocation', {
        details: { chargeId: charge.id },
      });
    }

    // Duplicate lines for one charge are folded together before the balance
    // check, so two half-lines cannot slip past a single-line limit.
    const running = perChargeTotal.get(charge.id);
    perChargeTotal.set(charge.id, running ? add(running, line.amount) : line.amount);
    seenCharges.add(charge.id);
  }

  const resultingChargeBalances = new Map<string, Money>();
  for (const chargeId of seenCharges) {
    const charge = chargeIndex.get(chargeId)!;
    const requested = perChargeTotal.get(chargeId)!;
    const open = chargeOpenBalance(charge);
    if (compareMoney(requested, open) > 0) {
      throw new DomainError(
        'INSUFFICIENT_CHARGE_BALANCE',
        `Allocating ${formatMoney(requested)} would exceed the ${formatMoney(open)} still open on this charge`,
        {
          details: {
            chargeId,
            requestedCents: requested.cents,
            openBalanceCents: open.cents,
            chargeVersion: charge.version,
          },
        },
      );
    }
    resultingChargeBalances.set(chargeId, subtract(open, requested));
  }

  const totalAllocated = sum(
    lines.map((line) => line.amount),
    transaction.currency,
  );
  const available = transactionOpenBalance(transaction);

  if (compareMoney(totalAllocated, available) > 0) {
    throw new DomainError(
      'INSUFFICIENT_PAYMENT_BALANCE',
      `Allocating ${formatMoney(totalAllocated)} would exceed the ${formatMoney(available)} still unapplied on this payment`,
      {
        details: {
          transactionId: transaction.id,
          requestedCents: totalAllocated.cents,
          availableCents: available.cents,
          transactionVersion: transaction.version,
        },
      },
    );
  }

  const remainingUnapplied = subtract(available, totalAllocated);

  return {
    lines,
    totalAllocated,
    remainingUnapplied,
    resultingChargeBalances,
    fullyApplied: remainingUnapplied.cents === 0,
  };
}

/** The transaction status implied by its balances after an allocation change. */
export function nextTransactionStatus(
  transaction: TransactionSnapshot,
  allocatedAfter: Money,
): TransactionStatus {
  if (transaction.status === TransactionStatus.REVERSED) return TransactionStatus.REVERSED;
  if (transaction.status === TransactionStatus.EXCLUDED) return TransactionStatus.EXCLUDED;
  if (allocatedAfter.cents === 0) return TransactionStatus.UNAPPLIED;
  if (allocatedAfter.cents >= transaction.amount.cents) return TransactionStatus.ALLOCATED;
  return TransactionStatus.PARTIALLY_ALLOCATED;
}

/** The charge status implied by its balances after an allocation or credit. */
export function nextChargeStatus(
  charge: ChargeSnapshot,
  allocatedAfter: Money,
  creditedAfter: Money,
): ChargeStatus {
  if (creditedAfter.cents >= charge.amount.cents) return ChargeStatus.VOIDED;
  if (allocatedAfter.cents + creditedAfter.cents >= charge.amount.cents) {
    return ChargeStatus.SETTLED;
  }
  return ChargeStatus.POSTED;
}

export interface ReversalInput {
  readonly allocationId: string;
  readonly allocationStatus: string;
  readonly allocatedAmount: Money;
  readonly transaction: TransactionSnapshot;
  readonly charge: ChargeSnapshot;
}

export interface ReversalPlan {
  readonly allocationId: string;
  /** Always the full allocated amount. Partial reversal is not supported in v1. */
  readonly reversedAmount: Money;
  readonly transactionAllocatedAfter: Money;
  readonly chargeAllocatedAfter: Money;
  readonly transactionStatusAfter: TransactionStatus;
  readonly chargeStatusAfter: ChargeStatus;
}

/**
 * Plans the reversal of one active allocation.
 *
 * Reversal is all-or-nothing: partially unwinding an allocation would leave two
 * records claiming the same cents, so a partial correction is expressed as a
 * full reversal followed by a new, smaller allocation.
 */
export function planReversal(input: ReversalInput): ReversalPlan {
  if (input.allocationStatus !== 'ACTIVE') {
    throw new DomainError(
      'ALLOCATION_ALREADY_REVERSED',
      'This allocation has already been reversed',
      { details: { allocationId: input.allocationId, status: input.allocationStatus } },
    );
  }
  if (!isPositive(input.allocatedAmount)) {
    throw new DomainError('VALIDATION_FAILED', 'Allocation amount must be positive to reverse', {
      details: { allocationId: input.allocationId },
    });
  }

  const transactionAllocatedAfter = subtract(
    input.transaction.allocatedAmount,
    input.allocatedAmount,
  );
  const chargeAllocatedAfter = subtract(input.charge.allocatedAmount, input.allocatedAmount);

  if (transactionAllocatedAfter.cents < 0 || chargeAllocatedAfter.cents < 0) {
    throw new DomainError(
      'CONFLICT',
      'Reversing this allocation would drive an allocated total below zero. Reload and retry.',
      {
        details: {
          allocationId: input.allocationId,
          transactionAllocatedAfterCents: transactionAllocatedAfter.cents,
          chargeAllocatedAfterCents: chargeAllocatedAfter.cents,
        },
      },
    );
  }

  return {
    allocationId: input.allocationId,
    reversedAmount: input.allocatedAmount,
    transactionAllocatedAfter,
    chargeAllocatedAfter,
    transactionStatusAfter: nextTransactionStatus(input.transaction, transactionAllocatedAfter),
    chargeStatusAfter: nextChargeStatus(
      input.charge,
      chargeAllocatedAfter,
      input.charge.creditedAmount,
    ),
  };
}

/**
 * Greedily fills charges in the caller's priority order from the payment's
 * available balance. Used to turn a ranked list of candidate charges into
 * concrete line amounts; the result still goes through `planAllocation`.
 */
export function fillChargesInOrder(
  available: Money,
  charges: readonly ChargeSnapshot[],
): AllocationLine[] {
  const lines: AllocationLine[] = [];
  let remaining = available;

  for (const charge of charges) {
    if (remaining.cents <= 0) break;
    const open = chargeOpenBalance(charge);
    if (open.cents <= 0) continue;
    const take = money(Math.min(remaining.cents, open.cents), available.currency);
    lines.push({ chargeId: charge.id, amount: take });
    remaining = subtract(remaining, take);
  }

  return lines;
}

/** Total of a line set, or zero in `currency` when there are no lines. */
export function totalOfLines(lines: readonly AllocationLine[], currency: string): Money {
  if (lines.length === 0) return zero(currency);
  return sum(
    lines.map((line) => line.amount),
    currency,
  );
}
