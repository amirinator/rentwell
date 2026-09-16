/**
 * Month-end close readiness.
 *
 * Close is evaluated twice: once when the controller opens the close workspace,
 * to show what still needs doing, and again inside the close transaction while
 * holding the period lock. This module is the single definition of "ready",
 * so the two evaluations cannot disagree.
 *
 * Blockers stop the close outright. Acknowledgements are conditions a
 * controller may accept in writing; each one closes with a stated reason that
 * is recorded in the close snapshot.
 */

import { formatCents, money, type CurrencyCode, type Money } from '../money/money';
import type { PeriodKey } from '../periods/dates';
import {
  PeriodStatus,
  Role,
  type PeriodStatus as PeriodStatusValue,
  type Role as RoleValue,
} from '../types';
import { DomainError } from '../errors';

export type CloseBlockerCode =
  | 'PERIOD_NOT_IN_REVIEW'
  | 'PRIOR_PERIOD_NOT_CLOSED'
  | 'CHARGE_GENERATION_INCOMPLETE'
  | 'IMPORTS_IN_PROGRESS'
  | 'POSTING_JOBS_ACTIVE'
  | 'UNREVIEWED_TRANSACTIONS'
  | 'BLOCKING_EXCEPTIONS_OPEN'
  | 'SUBLEDGER_OUT_OF_BALANCE'
  | 'SUMMARY_DISAGREES_WITH_SUBLEDGER'
  | 'PENDING_APPROVALS';

export type CloseAcknowledgementCode =
  | 'OUTSTANDING_RECEIVABLES'
  | 'UNAPPLIED_CASH_REMAINS'
  | 'NON_BLOCKING_EXCEPTIONS'
  | 'OPERATIONAL_NOTES';

export interface CloseBlocker {
  readonly code: CloseBlockerCode;
  readonly message: string;
  /** How many records are responsible, when countable. */
  readonly count: number | null;
  /** Where the controller goes to resolve it. */
  readonly resolutionHint: string;
}

export interface CloseAcknowledgement {
  readonly code: CloseAcknowledgementCode;
  readonly message: string;
  readonly count: number | null;
  readonly amountCents: number | null;
  /** True when the controller must supply a reason alongside the tick. */
  readonly requiresReason: boolean;
}

/** Everything the close evaluation needs, gathered by the API under a lock. */
export interface CloseFacts {
  readonly propertyId: string;
  readonly period: PeriodKey;
  readonly currency: CurrencyCode;
  readonly periodStatus: PeriodStatusValue;
  /** Status of the immediately preceding period, or null if none exists. */
  readonly priorPeriodStatus: PeriodStatusValue | null;
  /** Active leases in this period with no generated charge for a due schedule. */
  readonly leasesMissingCharges: number;
  /** Imports not yet in a terminal state. */
  readonly activeImportCount: number;
  /** Queued or running posting jobs touching this property and period. */
  readonly activePostingJobCount: number;
  /** Undispatched outbox events for this property. */
  readonly pendingOutboxCount: number;
  /** Received transactions with no allocation and no exception. */
  readonly unreviewedTransactionCount: number;
  readonly blockingExceptionCount: number;
  readonly nonBlockingExceptionCount: number;
  /** Suggestions explicitly submitted for approval and still waiting. */
  readonly pendingApprovalCount: number;
  /** Sum of (debit - credit) over all journal lines in the period. Must be 0. */
  readonly netDebitMinusCreditCents: number;
  /** Receivables balance derived from the subledger. */
  readonly subledgerReceivablesCents: number;
  /** Receivables balance derived from charge records. Must agree. */
  readonly chargeDerivedReceivablesCents: number;
  readonly unappliedCashCents: number;
  /** Unapplied cash without a recorded classification. */
  readonly unclassifiedUnappliedCashCents: number;
  readonly chargesPostedCents: number;
  readonly paymentsReceivedCents: number;
  readonly paymentsAllocatedCents: number;
}

export interface CloseReadiness {
  readonly propertyId: string;
  readonly period: PeriodKey;
  readonly periodStatus: PeriodStatusValue;
  readonly blockers: readonly CloseBlocker[];
  readonly acknowledgements: readonly CloseAcknowledgement[];
  readonly totals: CloseTotals;
  /** True when no blockers remain. Acknowledgements may still be outstanding. */
  readonly canClose: boolean;
  readonly evaluatedAt: string;
}

export interface CloseTotals {
  readonly chargesPosted: Money;
  readonly paymentsReceived: Money;
  readonly paymentsAllocated: Money;
  readonly outstandingReceivables: Money;
  readonly unappliedCash: Money;
}

/** Exceptions in these categories block the close until resolved. */
export const BLOCKING_EXCEPTION_CATEGORIES: readonly string[] = [
  'AMBIGUOUS_MATCH',
  'CURRENCY_MISMATCH',
  'INTEGRATION_CONFLICT',
  'REVERSED_PAYMENT',
  'SUSPECTED_DUPLICATE',
];

export function evaluateCloseReadiness(facts: CloseFacts, now: Date = new Date()): CloseReadiness {
  const blockers: CloseBlocker[] = [];
  const acknowledgements: CloseAcknowledgement[] = [];

  if (facts.periodStatus !== PeriodStatus.IN_REVIEW) {
    blockers.push({
      code: 'PERIOD_NOT_IN_REVIEW',
      message:
        facts.periodStatus === PeriodStatus.CLOSED
          ? 'This period is already closed.'
          : 'Move the period into review before closing it.',
      count: null,
      resolutionHint: 'Close workspace: Start review',
    });
  }

  if (facts.priorPeriodStatus !== null && facts.priorPeriodStatus !== PeriodStatus.CLOSED) {
    blockers.push({
      code: 'PRIOR_PERIOD_NOT_CLOSED',
      message: 'The preceding accounting period is still open. Close periods in order.',
      count: null,
      resolutionHint: 'Close workspace: previous period',
    });
  }

  if (facts.leasesMissingCharges > 0) {
    blockers.push({
      code: 'CHARGE_GENERATION_INCOMPLETE',
      message: `${facts.leasesMissingCharges} active lease(s) have no generated charge for this period.`,
      count: facts.leasesMissingCharges,
      resolutionHint: 'Property workspace: Generate charges',
    });
  }

  if (facts.activeImportCount > 0) {
    blockers.push({
      code: 'IMPORTS_IN_PROGRESS',
      message: `${facts.activeImportCount} payment import(s) have not reached a terminal status.`,
      count: facts.activeImportCount,
      resolutionHint: 'Import center',
    });
  }

  const activeJobs = facts.activePostingJobCount + facts.pendingOutboxCount;
  if (activeJobs > 0) {
    blockers.push({
      code: 'POSTING_JOBS_ACTIVE',
      message: `${activeJobs} background posting job(s) or undispatched event(s) are still in flight.`,
      count: activeJobs,
      resolutionHint: 'Administration: background processing',
    });
  }

  if (facts.unreviewedTransactionCount > 0) {
    blockers.push({
      code: 'UNREVIEWED_TRANSACTIONS',
      message: `${facts.unreviewedTransactionCount} received payment(s) have been neither allocated nor raised as an exception.`,
      count: facts.unreviewedTransactionCount,
      resolutionHint: 'Reconciliation workbench',
    });
  }

  if (facts.blockingExceptionCount > 0) {
    blockers.push({
      code: 'BLOCKING_EXCEPTIONS_OPEN',
      message: `${facts.blockingExceptionCount} blocking exception(s) are unresolved.`,
      count: facts.blockingExceptionCount,
      resolutionHint: 'Exception workspace',
    });
  }

  if (facts.pendingApprovalCount > 0) {
    blockers.push({
      code: 'PENDING_APPROVALS',
      message: `${facts.pendingApprovalCount} allocation(s) are waiting for approval.`,
      count: facts.pendingApprovalCount,
      resolutionHint: 'Reconciliation workbench: pending approvals',
    });
  }

  if (facts.netDebitMinusCreditCents !== 0) {
    blockers.push({
      code: 'SUBLEDGER_OUT_OF_BALANCE',
      message:
        `Journal debits and credits differ by ${formatCents(facts.netDebitMinusCreditCents, facts.currency)} ${facts.currency}. ` +
        'This indicates a defect and must be investigated before closing.',
      count: null,
      resolutionHint: 'Subledger explorer',
    });
  }

  if (facts.subledgerReceivablesCents !== facts.chargeDerivedReceivablesCents) {
    const difference = facts.subledgerReceivablesCents - facts.chargeDerivedReceivablesCents;
    blockers.push({
      code: 'SUMMARY_DISAGREES_WITH_SUBLEDGER',
      message: `Receivables derived from charges disagree with the subledger by ${formatCents(difference, facts.currency)} ${facts.currency}.`,
      count: null,
      resolutionHint: 'Subledger explorer: reconciliation report',
    });
  }

  // --- Acknowledgements ---------------------------------------------------

  if (facts.chargeDerivedReceivablesCents !== 0) {
    acknowledgements.push({
      code: 'OUTSTANDING_RECEIVABLES',
      message: `${formatCents(facts.chargeDerivedReceivablesCents, facts.currency)} ${facts.currency} remains outstanding from tenants.`,
      count: null,
      amountCents: facts.chargeDerivedReceivablesCents,
      requiresReason: false,
    });
  }

  if (facts.unappliedCashCents !== 0) {
    acknowledgements.push({
      code: 'UNAPPLIED_CASH_REMAINS',
      message:
        `${formatCents(facts.unappliedCashCents, facts.currency)} ${facts.currency} of received cash is not matched to a charge` +
        (facts.unclassifiedUnappliedCashCents !== 0
          ? `, of which ${formatCents(facts.unclassifiedUnappliedCashCents, facts.currency)} has no recorded classification.`
          : '. All of it is classified.'),
      count: null,
      amountCents: facts.unappliedCashCents,
      // Unapplied cash may remain at close only when a controller says why.
      requiresReason: true,
    });
  }

  if (facts.nonBlockingExceptionCount > 0) {
    acknowledgements.push({
      code: 'NON_BLOCKING_EXCEPTIONS',
      message: `${facts.nonBlockingExceptionCount} non-blocking exception(s) will carry into the next period.`,
      count: facts.nonBlockingExceptionCount,
      amountCents: null,
      requiresReason: true,
    });
  }

  const totals: CloseTotals = {
    chargesPosted: money(facts.chargesPostedCents, facts.currency),
    paymentsReceived: money(facts.paymentsReceivedCents, facts.currency),
    paymentsAllocated: money(facts.paymentsAllocatedCents, facts.currency),
    outstandingReceivables: money(facts.chargeDerivedReceivablesCents, facts.currency),
    unappliedCash: money(facts.unappliedCashCents, facts.currency),
  };

  return {
    propertyId: facts.propertyId,
    period: facts.period,
    periodStatus: facts.periodStatus,
    blockers,
    acknowledgements,
    totals,
    canClose: blockers.length === 0,
    evaluatedAt: now.toISOString(),
  };
}

export interface CloseAttempt {
  readonly readiness: CloseReadiness;
  /** Codes the controller has ticked, with the reason they supplied. */
  readonly acknowledged: readonly { code: CloseAcknowledgementCode; reason: string | null }[];
  readonly actorRole: RoleValue;
}

/**
 * Final gate, called inside the close transaction while the period lock is
 * held. Throws with the list of unmet conditions rather than returning false,
 * so a caller cannot ignore the result by accident.
 */
export function assertCloseAllowed(attempt: CloseAttempt): void {
  const { readiness } = attempt;

  // Administrative access does not carry financial approval authority: an
  // organization administrator manages users and integrations, and is
  // deliberately not able to close a period.
  if (attempt.actorRole !== Role.PORTFOLIO_CONTROLLER) {
    throw new DomainError(
      'FORBIDDEN',
      'Only a portfolio controller can close an accounting period',
      {
        details: { actorRole: attempt.actorRole },
      },
    );
  }

  if (readiness.blockers.length > 0) {
    throw new DomainError('CLOSE_BLOCKED', 'This period still has unresolved close blockers', {
      details: {
        propertyId: readiness.propertyId,
        period: readiness.period,
        blockers: readiness.blockers.map((blocker) => blocker.code),
      },
    });
  }

  const acknowledgedByCode = new Map(attempt.acknowledged.map((item) => [item.code, item]));
  const missing: CloseAcknowledgementCode[] = [];
  const missingReason: CloseAcknowledgementCode[] = [];

  for (const required of readiness.acknowledgements) {
    const provided = acknowledgedByCode.get(required.code);
    if (!provided) {
      missing.push(required.code);
      continue;
    }
    if (
      required.requiresReason &&
      (provided.reason === null || provided.reason.trim().length === 0)
    ) {
      missingReason.push(required.code);
    }
  }

  if (missing.length > 0 || missingReason.length > 0) {
    throw new DomainError(
      'CLOSE_BLOCKED',
      'Close requires every listed condition to be acknowledged',
      {
        details: {
          propertyId: readiness.propertyId,
          period: readiness.period,
          notAcknowledged: missing,
          missingReason,
        },
      },
    );
  }
}

/** The immutable record written when a period closes. */
export interface CloseSnapshotDraft {
  readonly propertyId: string;
  readonly period: PeriodKey;
  readonly currency: CurrencyCode;
  readonly totals: CloseTotals;
  readonly checklist: readonly {
    code: string;
    kind: 'BLOCKER' | 'ACKNOWLEDGEMENT';
    satisfied: boolean;
    message: string;
    reason: string | null;
  }[];
  readonly closedByUserId: string;
  readonly closedAt: string;
  readonly readinessEvaluatedAt: string;
}

export function buildCloseSnapshot(
  attempt: CloseAttempt,
  closedByUserId: string,
  closedAt: Date = new Date(),
): CloseSnapshotDraft {
  const { readiness } = attempt;
  const acknowledgedByCode = new Map(attempt.acknowledged.map((item) => [item.code, item]));

  const checklist = [
    ...readiness.blockers.map((blocker) => ({
      code: blocker.code,
      kind: 'BLOCKER' as const,
      satisfied: false,
      message: blocker.message,
      reason: null,
    })),
    ...readiness.acknowledgements.map((item) => ({
      code: item.code,
      kind: 'ACKNOWLEDGEMENT' as const,
      satisfied: acknowledgedByCode.has(item.code),
      message: item.message,
      reason: acknowledgedByCode.get(item.code)?.reason ?? null,
    })),
  ];

  return {
    propertyId: readiness.propertyId,
    period: readiness.period,
    currency: readiness.totals.chargesPosted.currency,
    totals: readiness.totals,
    checklist,
    closedByUserId,
    closedAt: closedAt.toISOString(),
    readinessEvaluatedAt: readiness.evaluatedAt,
  };
}

/** Valid period state transitions. Anything else is rejected. */
const PERIOD_TRANSITIONS: Readonly<Record<PeriodStatusValue, readonly PeriodStatusValue[]>> = {
  [PeriodStatus.OPEN]: [PeriodStatus.IN_REVIEW],
  [PeriodStatus.IN_REVIEW]: [PeriodStatus.OPEN, PeriodStatus.CLOSED],
  [PeriodStatus.CLOSED]: [PeriodStatus.OPEN],
};

export function assertPeriodTransition(
  from: PeriodStatusValue,
  to: PeriodStatusValue,
  actorRole: RoleValue,
): void {
  const allowed = PERIOD_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new DomainError('PERIOD_STATE_INVALID', `A period cannot move from ${from} to ${to}`, {
      details: { from, to, allowed },
    });
  }
  // Reopening a closed period is a controller decision and always needs a reason,
  // which the caller supplies; the role check lives here so every path shares it.
  if (from === PeriodStatus.CLOSED && actorRole !== Role.PORTFOLIO_CONTROLLER) {
    throw new DomainError('FORBIDDEN', 'Only a portfolio controller can reopen a closed period', {
      details: { actorRole },
    });
  }
}

/** True when a financial posting is permitted in this period state. */
export function periodAcceptsPostings(status: PeriodStatusValue): boolean {
  return status === PeriodStatus.OPEN || status === PeriodStatus.IN_REVIEW;
}
