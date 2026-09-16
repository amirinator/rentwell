/**
 * Exception classification and resolution rules.
 *
 * An exception records that a payment could not be reconciled cleanly. Closing
 * one must never be a way to make a discrepancy disappear: where a balance is
 * wrong, the resolution has to name the financial action that fixed it, or an
 * explicit authorized classification of why the difference is acceptable.
 */

import { compareMoney, formatMoney, isPositive, subtract, type Money } from '../money/money';
import {
  ExceptionCategory,
  ExceptionResolution,
  ExceptionSeverity,
  ExceptionStatus,
  Role,
  TransactionStatus,
  transactionOpenBalance,
  type ExceptionCategory as ExceptionCategoryValue,
  type ExceptionResolution as ExceptionResolutionValue,
  type ExceptionSeverity as ExceptionSeverityValue,
  type ExceptionStatus as ExceptionStatusValue,
  type Role as RoleValue,
  type TransactionSnapshot,
} from '../types';
import { DomainError } from '../errors';

/** Categories that must be resolved before a period can close. */
export const BLOCKING_CATEGORIES: ReadonlySet<ExceptionCategoryValue> =
  new Set<ExceptionCategoryValue>([
    ExceptionCategory.AMBIGUOUS_MATCH,
    ExceptionCategory.CURRENCY_MISMATCH,
    ExceptionCategory.INTEGRATION_CONFLICT,
    ExceptionCategory.REVERSED_PAYMENT,
    ExceptionCategory.SUSPECTED_DUPLICATE,
  ]);

export function isBlockingCategory(category: ExceptionCategoryValue): boolean {
  return BLOCKING_CATEGORIES.has(category);
}

export interface ClassificationInput {
  readonly transaction: TransactionSnapshot;
  /** Number of candidate suggestions produced for the transaction. */
  readonly suggestionCount: number;
  /** True when the top two suggestions scored identically. */
  readonly hasTiedSuggestions: boolean;
  /** Total open balance of the tenant's charges, when a tenant was resolved. */
  readonly tenantOpenBalance: Money | null;
  /** True when another transaction has the same amount, date and reference. */
  readonly hasProbableDuplicate: boolean;
  /** True when the provider currency differs from the property currency. */
  readonly currencyMismatch: boolean;
  /** True when the provider reported a reversal for this transaction. */
  readonly providerReversed: boolean;
  /** True when a reversal referenced a transaction we do not hold. */
  readonly unknownReversalTarget: boolean;
}

export interface Classification {
  readonly category: ExceptionCategoryValue;
  readonly severity: ExceptionSeverityValue;
  readonly summary: string;
}

/**
 * Chooses the single most useful category for an unreconciled payment.
 *
 * Ordered by how much the category constrains what the accountant should do
 * next: integrity problems first, then ambiguity, then arithmetic differences.
 * Returns null when the transaction reconciles cleanly and needs no exception.
 */
export function classifyTransaction(input: ClassificationInput): Classification | null {
  const { transaction } = input;
  const unapplied = transactionOpenBalance(transaction);

  if (input.unknownReversalTarget) {
    return {
      category: ExceptionCategory.INTEGRATION_CONFLICT,
      severity: ExceptionSeverity.CRITICAL,
      summary: 'The provider reversed a payment that does not exist in Rentwell.',
    };
  }

  if (input.currencyMismatch) {
    return {
      category: ExceptionCategory.CURRENCY_MISMATCH,
      severity: ExceptionSeverity.HIGH,
      summary: `Payment is in ${transaction.currency}, which does not match the property's configured currency.`,
    };
  }

  if (input.providerReversed || transaction.status === TransactionStatus.REVERSED) {
    return {
      category: ExceptionCategory.REVERSED_PAYMENT,
      severity: ExceptionSeverity.HIGH,
      summary:
        'The provider reversed this payment. Confirm the allocations were unwound correctly.',
    };
  }

  if (input.hasProbableDuplicate) {
    return {
      category: ExceptionCategory.SUSPECTED_DUPLICATE,
      severity: ExceptionSeverity.HIGH,
      summary: 'Another payment has the same amount, date and reference on this bank account.',
    };
  }

  if (unapplied.cents <= 0) return null;

  if (input.hasTiedSuggestions || input.suggestionCount > 1) {
    return {
      category: ExceptionCategory.AMBIGUOUS_MATCH,
      severity: ExceptionSeverity.MEDIUM,
      summary: `${input.suggestionCount} candidate matches scored equally. A person must choose.`,
    };
  }

  if (input.suggestionCount === 0) {
    return {
      category: ExceptionCategory.MISSING_REFERENCE,
      severity: ExceptionSeverity.MEDIUM,
      summary: 'No tenant could be identified from the payment reference or description.',
    };
  }

  if (input.tenantOpenBalance !== null) {
    if (compareMoney(unapplied, input.tenantOpenBalance) > 0) {
      const excess = subtract(unapplied, input.tenantOpenBalance);
      return {
        category: ExceptionCategory.OVERPAYMENT,
        severity: ExceptionSeverity.LOW,
        summary: `Payment exceeds everything this tenant owes by ${formatMoney(excess)}.`,
      };
    }
    if (isPositive(input.tenantOpenBalance)) {
      return {
        category: ExceptionCategory.UNDERPAYMENT,
        severity: ExceptionSeverity.LOW,
        summary: `Payment settles part of the tenant's ${formatMoney(input.tenantOpenBalance)} balance.`,
      };
    }
  }

  return {
    category: ExceptionCategory.MISSING_REFERENCE,
    severity: ExceptionSeverity.MEDIUM,
    summary: 'Payment could not be matched to a charge automatically.',
  };
}

// --------------------------------------------------------------------------
// Workflow transitions
// --------------------------------------------------------------------------

const EXCEPTION_TRANSITIONS: Readonly<
  Record<ExceptionStatusValue, readonly ExceptionStatusValue[]>
> = Object.freeze({
  [ExceptionStatus.OPEN]: [
    ExceptionStatus.ASSIGNED,
    ExceptionStatus.IN_REVIEW,
    ExceptionStatus.RESOLVED,
  ],
  [ExceptionStatus.ASSIGNED]: [
    ExceptionStatus.IN_REVIEW,
    ExceptionStatus.OPEN,
    ExceptionStatus.RESOLVED,
  ],
  [ExceptionStatus.IN_REVIEW]: [
    ExceptionStatus.RESOLVED,
    ExceptionStatus.ASSIGNED,
    ExceptionStatus.OPEN,
  ],
  // Reopening is allowed, and the caller must supply a reason.
  [ExceptionStatus.RESOLVED]: [ExceptionStatus.OPEN, ExceptionStatus.IN_REVIEW],
});

export function assertExceptionTransition(
  from: ExceptionStatusValue,
  to: ExceptionStatusValue,
  reason: string | null,
): void {
  const allowed = EXCEPTION_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new DomainError('VALIDATION_FAILED', `An exception cannot move from ${from} to ${to}`, {
      details: { from, to, allowed },
    });
  }
  if (from === ExceptionStatus.RESOLVED && (reason === null || reason.trim().length === 0)) {
    throw new DomainError('VALIDATION_FAILED', 'Reopening a resolved exception requires a reason', {
      details: { from, to },
    });
  }
}

// --------------------------------------------------------------------------
// Resolution rules
// --------------------------------------------------------------------------

/** Resolutions that assert a financial action actually took place. */
const FINANCIAL_RESOLUTIONS: ReadonlySet<ExceptionResolutionValue> =
  new Set<ExceptionResolutionValue>([
    ExceptionResolution.ALLOCATED,
    ExceptionResolution.REVERSED,
    ExceptionResolution.CREDIT_ISSUED,
  ]);

/** Resolutions that record a judgement instead of a financial movement. */
const CLASSIFICATION_RESOLUTIONS: ReadonlySet<ExceptionResolutionValue> =
  new Set<ExceptionResolutionValue>([
    ExceptionResolution.CLASSIFIED_UNAPPLIED,
    ExceptionResolution.DUPLICATE_CONFIRMED,
    ExceptionResolution.WRITTEN_OFF,
    ExceptionResolution.NO_ACTION_REQUIRED,
  ]);

/** Classifications that only a controller may record. */
const CONTROLLER_ONLY_RESOLUTIONS: ReadonlySet<ExceptionResolutionValue> =
  new Set<ExceptionResolutionValue>([
    ExceptionResolution.WRITTEN_OFF,
    ExceptionResolution.CLASSIFIED_UNAPPLIED,
  ]);

export interface ResolutionAttempt {
  readonly category: ExceptionCategoryValue;
  readonly resolution: ExceptionResolutionValue;
  readonly reason: string;
  readonly actorRole: RoleValue;
  /** Financial state when the exception was raised. */
  readonly openAmountAtOpen: Money;
  /** Financial state now, after whatever the accountant did. */
  readonly openAmountNow: Money;
  /** Allocations created against this transaction since the exception opened. */
  readonly allocationsCreated: number;
  /** Reversals recorded against this transaction since the exception opened. */
  readonly reversalsCreated: number;
  /** Credit adjustments recorded against related charges. */
  readonly creditsCreated: number;
}

/**
 * Validates that a proposed resolution is consistent with what actually
 * happened to the money.
 *
 * The check that matters: a discrepancy still on the books can only be closed
 * by a classification that an authorized role recorded on purpose. Claiming
 * ALLOCATED when no allocation exists, or silently closing a live difference,
 * is rejected.
 */
export function assertResolutionValid(attempt: ResolutionAttempt): void {
  if (attempt.reason.trim().length < 4) {
    throw new DomainError('VALIDATION_FAILED', 'Resolving an exception requires a stated reason', {
      details: { resolution: attempt.resolution },
    });
  }

  if (
    CONTROLLER_ONLY_RESOLUTIONS.has(attempt.resolution) &&
    attempt.actorRole !== Role.PORTFOLIO_CONTROLLER
  ) {
    throw new DomainError(
      'FORBIDDEN',
      `Resolution ${attempt.resolution} must be recorded by a portfolio controller`,
      { details: { resolution: attempt.resolution, actorRole: attempt.actorRole } },
    );
  }

  if (FINANCIAL_RESOLUTIONS.has(attempt.resolution)) {
    const actionCount =
      attempt.resolution === ExceptionResolution.ALLOCATED
        ? attempt.allocationsCreated
        : attempt.resolution === ExceptionResolution.REVERSED
          ? attempt.reversalsCreated
          : attempt.creditsCreated;

    if (actionCount === 0) {
      throw new DomainError(
        'EXCEPTION_UNRESOLVED',
        `Resolution ${attempt.resolution} requires a matching financial action, and none was recorded`,
        {
          details: {
            resolution: attempt.resolution,
            allocationsCreated: attempt.allocationsCreated,
            reversalsCreated: attempt.reversalsCreated,
            creditsCreated: attempt.creditsCreated,
          },
        },
      );
    }
    return;
  }

  if (!CLASSIFICATION_RESOLUTIONS.has(attempt.resolution)) {
    throw new DomainError('VALIDATION_FAILED', `Unknown resolution ${attempt.resolution}`, {
      details: { resolution: attempt.resolution },
    });
  }

  // A classification is only honest if it acknowledges the remaining amount.
  if (
    attempt.resolution === ExceptionResolution.NO_ACTION_REQUIRED &&
    attempt.openAmountNow.cents !== 0
  ) {
    throw new DomainError(
      'EXCEPTION_UNRESOLVED',
      `${formatMoney(attempt.openAmountNow)} is still unreconciled. Record what happens to it rather than closing with no action.`,
      { details: { openAmountNowCents: attempt.openAmountNow.cents } },
    );
  }
}

/** Severity implied by how long an exception has been open and its amount. */
export function escalatedSeverity(
  current: ExceptionSeverityValue,
  ageDays: number,
  amount: Money,
): ExceptionSeverityValue {
  if (current === ExceptionSeverity.CRITICAL) return current;
  if (ageDays >= 30 || amount.cents >= 5_000_00) return ExceptionSeverity.HIGH;
  if (ageDays >= 14 && current === ExceptionSeverity.LOW) return ExceptionSeverity.MEDIUM;
  return current;
}
