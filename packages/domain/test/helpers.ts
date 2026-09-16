import {
  ChargeStatus,
  DomainError,
  ChargeType,
  TransactionDirection,
  TransactionStatus,
  money,
  type ChargeSnapshot,
  type TransactionSnapshot,
} from '../src/index';

export const USD = 'USD';

export function usd(cents: number) {
  return money(cents, USD);
}

export function charge(overrides: Partial<ChargeSnapshot> & { id: string }): ChargeSnapshot {
  return {
    organizationId: 'org_1',
    propertyId: 'prop_1',
    leaseId: 'lease_1',
    tenantId: 'tenant_1',
    type: ChargeType.BASE_RENT,
    status: ChargeStatus.POSTED,
    currency: USD,
    amount: usd(100_000),
    creditedAmount: usd(0),
    allocatedAmount: usd(0),
    serviceStart: '2026-03-01',
    serviceEnd: '2026-03-31',
    dueDate: '2026-03-01',
    period: '2026-03',
    paymentReference: 'RW-1001',
    version: 1,
    ...overrides,
  };
}

export function transaction(
  overrides: Partial<TransactionSnapshot> & { id: string },
): TransactionSnapshot {
  return {
    organizationId: 'org_1',
    propertyId: 'prop_1',
    bankAccountId: 'bank_1',
    status: TransactionStatus.UNAPPLIED,
    direction: TransactionDirection.CREDIT,
    currency: USD,
    amount: usd(100_000),
    allocatedAmount: usd(0),
    postedDate: '2026-03-01',
    reference: 'RW-1001',
    description: null,
    version: 1,
    ...overrides,
  };
}

/**
 * Asserts that `fn` throws a DomainError carrying `code`, and returns it.
 * Preferred over `expect(...).toThrow(matcher)` because it checks the stable
 * error code rather than a message that may be reworded.
 */
export function expectDomainError(fn: () => unknown, code: string): DomainError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof DomainError)) {
    throw new Error(`Expected a DomainError with code ${code}, received ${String(thrown)}`);
  }
  if (thrown.code !== code) {
    throw new Error(
      `Expected DomainError code ${code}, received ${thrown.code}: ${thrown.message}`,
    );
  }
  return thrown;
}
