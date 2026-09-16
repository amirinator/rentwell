import { describe, expect, it } from 'vitest';
import {
  assertCloseAllowed,
  assertPeriodTransition,
  buildCloseSnapshot,
  evaluateCloseReadiness,
  periodAcceptsPostings,
  type CloseFacts,
} from '../src/close/readiness';
import { PeriodStatus, Role } from '../src/types';
import { expectDomainError } from './helpers';

const NOW = new Date('2026-04-02T09:00:00.000Z');

function facts(overrides: Partial<CloseFacts> = {}): CloseFacts {
  return {
    propertyId: 'prop_1',
    period: '2026-03',
    currency: 'USD',
    periodStatus: PeriodStatus.IN_REVIEW,
    priorPeriodStatus: PeriodStatus.CLOSED,
    leasesMissingCharges: 0,
    activeImportCount: 0,
    activePostingJobCount: 0,
    pendingOutboxCount: 0,
    unreviewedTransactionCount: 0,
    blockingExceptionCount: 0,
    nonBlockingExceptionCount: 0,
    pendingApprovalCount: 0,
    netDebitMinusCreditCents: 0,
    subledgerReceivablesCents: 0,
    chargeDerivedReceivablesCents: 0,
    unappliedCashCents: 0,
    unclassifiedUnappliedCashCents: 0,
    chargesPostedCents: 1_000_000,
    paymentsReceivedCents: 1_000_000,
    paymentsAllocatedCents: 1_000_000,
    ...overrides,
  };
}

function codes(items: readonly { code: string }[]): string[] {
  return items.map((item) => item.code).sort();
}

describe('evaluateCloseReadiness', () => {
  it('reports a clean period as ready with nothing to acknowledge', () => {
    const readiness = evaluateCloseReadiness(facts(), NOW);
    expect(readiness.blockers).toEqual([]);
    expect(readiness.acknowledgements).toEqual([]);
    expect(readiness.canClose).toBe(true);
    expect(readiness.evaluatedAt).toBe(NOW.toISOString());
    expect(readiness.totals.chargesPosted.cents).toBe(1_000_000);
  });

  it('blocks a period that is not yet in review', () => {
    const readiness = evaluateCloseReadiness(facts({ periodStatus: PeriodStatus.OPEN }), NOW);
    expect(codes(readiness.blockers)).toContain('PERIOD_NOT_IN_REVIEW');
    expect(readiness.canClose).toBe(false);
  });

  it('blocks when the preceding period is still open', () => {
    const readiness = evaluateCloseReadiness(facts({ priorPeriodStatus: PeriodStatus.OPEN }), NOW);
    expect(codes(readiness.blockers)).toContain('PRIOR_PERIOD_NOT_CLOSED');
  });

  it('allows the very first period, which has no predecessor', () => {
    const readiness = evaluateCloseReadiness(facts({ priorPeriodStatus: null }), NOW);
    expect(readiness.canClose).toBe(true);
  });

  it('collects every outstanding blocker rather than stopping at the first', () => {
    const readiness = evaluateCloseReadiness(
      facts({
        leasesMissingCharges: 3,
        activeImportCount: 1,
        unreviewedTransactionCount: 5,
        blockingExceptionCount: 2,
        pendingApprovalCount: 1,
        pendingOutboxCount: 4,
      }),
      NOW,
    );

    expect(codes(readiness.blockers)).toEqual([
      'BLOCKING_EXCEPTIONS_OPEN',
      'CHARGE_GENERATION_INCOMPLETE',
      'IMPORTS_IN_PROGRESS',
      'PENDING_APPROVALS',
      'POSTING_JOBS_ACTIVE',
      'UNREVIEWED_TRANSACTIONS',
    ]);
    expect(readiness.canClose).toBe(false);
  });

  it('treats an out-of-balance subledger as a defect that blocks the close', () => {
    const readiness = evaluateCloseReadiness(facts({ netDebitMinusCreditCents: -1 }), NOW);
    expect(codes(readiness.blockers)).toContain('SUBLEDGER_OUT_OF_BALANCE');
  });

  it('blocks when charge-derived receivables disagree with the subledger', () => {
    const readiness = evaluateCloseReadiness(
      facts({ subledgerReceivablesCents: 50_000, chargeDerivedReceivablesCents: 49_000 }),
      NOW,
    );
    expect(codes(readiness.blockers)).toContain('SUMMARY_DISAGREES_WITH_SUBLEDGER');
  });

  it('asks the controller to acknowledge outstanding receivables and unapplied cash', () => {
    const readiness = evaluateCloseReadiness(
      facts({
        subledgerReceivablesCents: 120_000,
        chargeDerivedReceivablesCents: 120_000,
        unappliedCashCents: 30_000,
        unclassifiedUnappliedCashCents: 30_000,
        nonBlockingExceptionCount: 2,
      }),
      NOW,
    );

    expect(codes(readiness.acknowledgements)).toEqual([
      'NON_BLOCKING_EXCEPTIONS',
      'OUTSTANDING_RECEIVABLES',
      'UNAPPLIED_CASH_REMAINS',
    ]);
    // Blockers are empty, so closing is possible once these are acknowledged.
    expect(readiness.canClose).toBe(true);
  });
});

describe('assertCloseAllowed', () => {
  const readiness = evaluateCloseReadiness(
    facts({
      subledgerReceivablesCents: 120_000,
      chargeDerivedReceivablesCents: 120_000,
      unappliedCashCents: 30_000,
      unclassifiedUnappliedCashCents: 30_000,
    }),
    NOW,
  );

  it('requires a portfolio controller', () => {
    expectDomainError(
      () =>
        assertCloseAllowed({
          readiness,
          acknowledged: [
            { code: 'OUTSTANDING_RECEIVABLES', reason: null },
            { code: 'UNAPPLIED_CASH_REMAINS', reason: 'Tenant credit pending instruction' },
          ],
          actorRole: Role.ACCOUNTANT,
        }),
      'FORBIDDEN',
    );
  });

  it('does not treat administrative access as financial approval authority', () => {
    expectDomainError(
      () =>
        assertCloseAllowed({
          readiness,
          acknowledged: [
            { code: 'OUTSTANDING_RECEIVABLES', reason: null },
            { code: 'UNAPPLIED_CASH_REMAINS', reason: 'Tenant credit pending instruction' },
          ],
          actorRole: Role.ORG_ADMIN,
        }),
      'FORBIDDEN',
    );
  });

  it('refuses while any blocker remains', () => {
    const blocked = evaluateCloseReadiness(facts({ blockingExceptionCount: 1 }), NOW);
    expectDomainError(
      () =>
        assertCloseAllowed({
          readiness: blocked,
          acknowledged: [],
          actorRole: Role.PORTFOLIO_CONTROLLER,
        }),
      'CLOSE_BLOCKED',
    );
  });

  it('refuses when a required acknowledgement is missing', () => {
    expectDomainError(
      () =>
        assertCloseAllowed({
          readiness,
          acknowledged: [{ code: 'OUTSTANDING_RECEIVABLES', reason: null }],
          actorRole: Role.PORTFOLIO_CONTROLLER,
        }),
      'CLOSE_BLOCKED',
    );
  });

  it('refuses when an acknowledgement that needs a reason has none', () => {
    const error = expectDomainError(
      () =>
        assertCloseAllowed({
          readiness,
          acknowledged: [
            { code: 'OUTSTANDING_RECEIVABLES', reason: null },
            { code: 'UNAPPLIED_CASH_REMAINS', reason: '   ' },
          ],
          actorRole: Role.PORTFOLIO_CONTROLLER,
        }),
      'CLOSE_BLOCKED',
    );
    expect(error.details.missingReason).toEqual(['UNAPPLIED_CASH_REMAINS']);
  });

  it('allows the close once everything is acknowledged by a controller', () => {
    expect(() =>
      assertCloseAllowed({
        readiness,
        acknowledged: [
          { code: 'OUTSTANDING_RECEIVABLES', reason: null },
          { code: 'UNAPPLIED_CASH_REMAINS', reason: 'Tenant credit pending instruction' },
        ],
        actorRole: Role.PORTFOLIO_CONTROLLER,
      }),
    ).not.toThrow();
  });
});

describe('close snapshot', () => {
  it('records totals, the checklist, the actor and the time', () => {
    const readiness = evaluateCloseReadiness(
      facts({
        subledgerReceivablesCents: 120_000,
        chargeDerivedReceivablesCents: 120_000,
        unappliedCashCents: 30_000,
      }),
      NOW,
    );
    const snapshot = buildCloseSnapshot(
      {
        readiness,
        acknowledged: [
          { code: 'OUTSTANDING_RECEIVABLES', reason: null },
          { code: 'UNAPPLIED_CASH_REMAINS', reason: 'Awaiting tenant instruction' },
        ],
        actorRole: Role.PORTFOLIO_CONTROLLER,
      },
      'user_controller',
      new Date('2026-04-02T10:00:00.000Z'),
    );

    expect(snapshot.propertyId).toBe('prop_1');
    expect(snapshot.period).toBe('2026-03');
    expect(snapshot.closedByUserId).toBe('user_controller');
    expect(snapshot.closedAt).toBe('2026-04-02T10:00:00.000Z');
    expect(snapshot.readinessEvaluatedAt).toBe(NOW.toISOString());
    expect(snapshot.totals.outstandingReceivables.cents).toBe(120_000);
    expect(snapshot.checklist).toHaveLength(2);
    expect(snapshot.checklist.every((item) => item.satisfied)).toBe(true);
    expect(snapshot.checklist.find((item) => item.code === 'UNAPPLIED_CASH_REMAINS')!.reason).toBe(
      'Awaiting tenant instruction',
    );
  });
});

describe('period state machine', () => {
  it('permits only the documented transitions', () => {
    expect(() =>
      assertPeriodTransition(PeriodStatus.OPEN, PeriodStatus.IN_REVIEW, Role.ACCOUNTANT),
    ).not.toThrow();
    expect(() =>
      assertPeriodTransition(
        PeriodStatus.IN_REVIEW,
        PeriodStatus.CLOSED,
        Role.PORTFOLIO_CONTROLLER,
      ),
    ).not.toThrow();

    expectDomainError(
      () =>
        assertPeriodTransition(PeriodStatus.OPEN, PeriodStatus.CLOSED, Role.PORTFOLIO_CONTROLLER),
      'PERIOD_STATE_INVALID',
    );
    expectDomainError(
      () =>
        assertPeriodTransition(
          PeriodStatus.CLOSED,
          PeriodStatus.IN_REVIEW,
          Role.PORTFOLIO_CONTROLLER,
        ),
      'PERIOD_STATE_INVALID',
    );
  });

  it('only lets a controller reopen a closed period', () => {
    expect(() =>
      assertPeriodTransition(PeriodStatus.CLOSED, PeriodStatus.OPEN, Role.PORTFOLIO_CONTROLLER),
    ).not.toThrow();
    expectDomainError(
      () => assertPeriodTransition(PeriodStatus.CLOSED, PeriodStatus.OPEN, Role.ACCOUNTANT),
      'FORBIDDEN',
    );
  });

  it('accepts postings only while the period is open or in review', () => {
    expect(periodAcceptsPostings(PeriodStatus.OPEN)).toBe(true);
    expect(periodAcceptsPostings(PeriodStatus.IN_REVIEW)).toBe(true);
    expect(periodAcceptsPostings(PeriodStatus.CLOSED)).toBe(false);
  });
});
