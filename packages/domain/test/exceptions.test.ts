import { describe, expect, it } from 'vitest';
import {
  assertExceptionTransition,
  assertResolutionValid,
  classifyTransaction,
  escalatedSeverity,
  isBlockingCategory,
  type ClassificationInput,
  type ResolutionAttempt,
} from '../src/exceptions/rules';
import {
  ExceptionCategory,
  ExceptionResolution,
  ExceptionSeverity,
  ExceptionStatus,
  Role,
  TransactionStatus,
} from '../src/types';
import { expectDomainError, transaction, usd } from './helpers';

function classification(overrides: Partial<ClassificationInput> = {}): ClassificationInput {
  return {
    transaction: transaction({ id: 'txn_1', amount: usd(100_000) }),
    suggestionCount: 1,
    hasTiedSuggestions: false,
    tenantOpenBalance: null,
    hasProbableDuplicate: false,
    currencyMismatch: false,
    providerReversed: false,
    unknownReversalTarget: false,
    ...overrides,
  };
}

function resolution(overrides: Partial<ResolutionAttempt> = {}): ResolutionAttempt {
  return {
    category: ExceptionCategory.UNDERPAYMENT,
    resolution: ExceptionResolution.ALLOCATED,
    reason: 'Matched to the correct invoice after speaking to the tenant',
    actorRole: Role.ACCOUNTANT,
    openAmountAtOpen: usd(40_000),
    openAmountNow: usd(0),
    allocationsCreated: 1,
    reversalsCreated: 0,
    creditsCreated: 0,
    ...overrides,
  };
}

describe('classifyTransaction', () => {
  it('returns nothing when the payment is fully applied', () => {
    expect(
      classifyTransaction(
        classification({
          transaction: transaction({
            id: 'txn_1',
            amount: usd(100_000),
            allocatedAmount: usd(100_000),
          }),
        }),
      ),
    ).toBeNull();
  });

  it('ranks an unknown reversal target above everything else', () => {
    const result = classifyTransaction(
      classification({
        unknownReversalTarget: true,
        currencyMismatch: true,
        hasProbableDuplicate: true,
      }),
    );
    expect(result!.category).toBe(ExceptionCategory.INTEGRATION_CONFLICT);
    expect(result!.severity).toBe(ExceptionSeverity.CRITICAL);
  });

  it('detects a currency mismatch', () => {
    const result = classifyTransaction(classification({ currencyMismatch: true }));
    expect(result!.category).toBe(ExceptionCategory.CURRENCY_MISMATCH);
  });

  it('detects a reversal reported by the provider', () => {
    expect(classifyTransaction(classification({ providerReversed: true }))!.category).toBe(
      ExceptionCategory.REVERSED_PAYMENT,
    );
    expect(
      classifyTransaction(
        classification({
          transaction: transaction({ id: 'txn_1', status: TransactionStatus.REVERSED }),
        }),
      )!.category,
    ).toBe(ExceptionCategory.REVERSED_PAYMENT);
  });

  it('detects a suspected duplicate', () => {
    expect(classifyTransaction(classification({ hasProbableDuplicate: true }))!.category).toBe(
      ExceptionCategory.SUSPECTED_DUPLICATE,
    );
  });

  it('records ambiguity when several candidates compete', () => {
    const result = classifyTransaction(
      classification({ suggestionCount: 3, hasTiedSuggestions: true }),
    );
    expect(result!.category).toBe(ExceptionCategory.AMBIGUOUS_MATCH);
    expect(result!.summary).toContain('3');
  });

  it('records a missing reference when nothing could be matched', () => {
    expect(classifyTransaction(classification({ suggestionCount: 0 }))!.category).toBe(
      ExceptionCategory.MISSING_REFERENCE,
    );
  });

  it('separates an overpayment from an underpayment', () => {
    expect(classifyTransaction(classification({ tenantOpenBalance: usd(40_000) }))!.category).toBe(
      ExceptionCategory.OVERPAYMENT,
    );
    expect(classifyTransaction(classification({ tenantOpenBalance: usd(150_000) }))!.category).toBe(
      ExceptionCategory.UNDERPAYMENT,
    );
  });

  it('marks integrity categories as close blockers', () => {
    expect(isBlockingCategory(ExceptionCategory.AMBIGUOUS_MATCH)).toBe(true);
    expect(isBlockingCategory(ExceptionCategory.INTEGRATION_CONFLICT)).toBe(true);
    expect(isBlockingCategory(ExceptionCategory.UNDERPAYMENT)).toBe(false);
    expect(isBlockingCategory(ExceptionCategory.OVERPAYMENT)).toBe(false);
  });
});

describe('exception workflow transitions', () => {
  it('permits the documented path', () => {
    expect(() =>
      assertExceptionTransition(ExceptionStatus.OPEN, ExceptionStatus.ASSIGNED, null),
    ).not.toThrow();
    expect(() =>
      assertExceptionTransition(ExceptionStatus.ASSIGNED, ExceptionStatus.IN_REVIEW, null),
    ).not.toThrow();
    expect(() =>
      assertExceptionTransition(ExceptionStatus.IN_REVIEW, ExceptionStatus.RESOLVED, null),
    ).not.toThrow();
  });

  it('requires a reason to reopen a resolved exception', () => {
    expectDomainError(
      () => assertExceptionTransition(ExceptionStatus.RESOLVED, ExceptionStatus.OPEN, null),
      'VALIDATION_FAILED',
    );
    expect(() =>
      assertExceptionTransition(ExceptionStatus.RESOLVED, ExceptionStatus.OPEN, 'Tenant disputed'),
    ).not.toThrow();
  });
});

describe('assertResolutionValid', () => {
  it('accepts a financial resolution backed by a real action', () => {
    expect(() => assertResolutionValid(resolution())).not.toThrow();
  });

  it('rejects a financial resolution with no matching action', () => {
    expectDomainError(
      () => assertResolutionValid(resolution({ allocationsCreated: 0 })),
      'EXCEPTION_UNRESOLVED',
    );
    expectDomainError(
      () =>
        assertResolutionValid(
          resolution({ resolution: ExceptionResolution.REVERSED, reversalsCreated: 0 }),
        ),
      'EXCEPTION_UNRESOLVED',
    );
    expectDomainError(
      () =>
        assertResolutionValid(
          resolution({ resolution: ExceptionResolution.CREDIT_ISSUED, creditsCreated: 0 }),
        ),
      'EXCEPTION_UNRESOLVED',
    );
  });

  it('requires a stated reason', () => {
    expectDomainError(
      () => assertResolutionValid(resolution({ reason: '   ' })),
      'VALIDATION_FAILED',
    );
  });

  it('refuses to close a live difference with "no action required"', () => {
    expectDomainError(
      () =>
        assertResolutionValid(
          resolution({
            resolution: ExceptionResolution.NO_ACTION_REQUIRED,
            allocationsCreated: 0,
            openAmountNow: usd(40_000),
          }),
        ),
      'EXCEPTION_UNRESOLVED',
    );
  });

  it('accepts "no action required" once nothing is outstanding', () => {
    expect(() =>
      assertResolutionValid(
        resolution({
          resolution: ExceptionResolution.NO_ACTION_REQUIRED,
          allocationsCreated: 0,
          openAmountNow: usd(0),
        }),
      ),
    ).not.toThrow();
  });

  it('restricts write-offs and unapplied classifications to a controller', () => {
    for (const restricted of [
      ExceptionResolution.WRITTEN_OFF,
      ExceptionResolution.CLASSIFIED_UNAPPLIED,
    ]) {
      expectDomainError(
        () =>
          assertResolutionValid(
            resolution({
              resolution: restricted,
              actorRole: Role.ACCOUNTANT,
              allocationsCreated: 0,
            }),
          ),
        'FORBIDDEN',
      );
      expect(() =>
        assertResolutionValid(
          resolution({
            resolution: restricted,
            actorRole: Role.PORTFOLIO_CONTROLLER,
            allocationsCreated: 0,
            openAmountNow: usd(40_000),
          }),
        ),
      ).not.toThrow();
    }
  });

  it('rejects an unknown resolution value', () => {
    expectDomainError(
      () =>
        assertResolutionValid(resolution({ resolution: 'SOMETHING_ELSE' as ExceptionResolution })),
      'VALIDATION_FAILED',
    );
  });
});

describe('escalatedSeverity', () => {
  it('escalates by age and by amount', () => {
    expect(escalatedSeverity(ExceptionSeverity.LOW, 3, usd(1000))).toBe(ExceptionSeverity.LOW);
    expect(escalatedSeverity(ExceptionSeverity.LOW, 16, usd(1000))).toBe(ExceptionSeverity.MEDIUM);
    expect(escalatedSeverity(ExceptionSeverity.LOW, 31, usd(1000))).toBe(ExceptionSeverity.HIGH);
    expect(escalatedSeverity(ExceptionSeverity.LOW, 1, usd(600_000))).toBe(ExceptionSeverity.HIGH);
  });

  it('never de-escalates a critical exception', () => {
    expect(escalatedSeverity(ExceptionSeverity.CRITICAL, 1, usd(1))).toBe(
      ExceptionSeverity.CRITICAL,
    );
  });
});
