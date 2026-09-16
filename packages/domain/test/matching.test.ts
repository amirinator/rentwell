import { describe, expect, it } from 'vitest';
import {
  MATCH_RULE_VERSION,
  generateSuggestions,
  isSuggestionStale,
  type MatchEngineInput,
  type TenantMatchInfo,
} from '../src/matching/engine';
import {
  extractReferenceCandidates,
  normalizeReference,
  sanitizeUntrustedText,
  tokenSetSimilarity,
  tokenize,
} from '../src/matching/normalize';
import { MatchStrategy, TransactionStatus } from '../src/types';
import { charge, transaction, usd } from './helpers';

const NOW = new Date('2026-03-20T12:00:00.000Z');

function tenantMap(
  ...tenants: { id: string; name: string; reference: string | null }[]
): ReadonlyMap<string, TenantMatchInfo> {
  const map = new Map<string, TenantMatchInfo>();
  for (const tenant of tenants) {
    map.set(tenant.id, {
      tenantId: tenant.id,
      displayName: tenant.name,
      paymentReference: tenant.reference,
      leaseReferences: [],
    });
  }
  return map;
}

const DEFAULT_TENANTS = tenantMap({
  id: 'tenant_1',
  name: 'Meridian Analytics LLC',
  reference: 'RW-1001',
});

function run(overrides: Partial<MatchEngineInput>) {
  return generateSuggestions({
    transaction: transaction({ id: 'txn_1' }),
    openCharges: [],
    tenants: DEFAULT_TENANTS,
    now: NOW,
    ...overrides,
  });
}

describe('normalization', () => {
  it('canonicalises a reference through bank mangling', () => {
    expect(normalizeReference('RW-1042 / A')).toBe('RW1042A');
    expect(normalizeReference('rw1042a')).toBe('RW1042A');
    expect(normalizeReference(null)).toBe('');
  });

  it('drops filler words from a payment memo', () => {
    expect(tokenize('ACH payment for rent - Meridian Analytics')).toEqual([
      'meridian',
      'analytics',
    ]);
  });

  it('measures token overlap', () => {
    expect(tokenSetSimilarity(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(tokenSetSimilarity(['a', 'b'], ['c'])).toBe(0);
    expect(tokenSetSimilarity([], ['a'])).toBe(0);
  });

  it('extracts reference-shaped substrings that contain a digit', () => {
    expect(extractReferenceCandidates('payment for invoice RW-1001 thanks')).toEqual(['RW1001']);
    expect(extractReferenceCandidates('no references here')).toEqual([]);
  });

  it('strips control characters from untrusted text', () => {
    expect(sanitizeUntrustedText('line one\nline\ttwo')).toBe('line one line two');
    expect(sanitizeUntrustedText('x'.repeat(600), 10)).toBe('xxxxxxxxxx...');
  });
});

describe('generateSuggestions', () => {
  it('proposes an exact match when reference and amount both agree', () => {
    const suggestions = run({
      transaction: transaction({ id: 'txn_1', amount: usd(100_000), reference: 'RW-1001' }),
      openCharges: [charge({ id: 'chg_1', amount: usd(100_000), dueDate: '2026-03-01' })],
    });

    expect(suggestions).toHaveLength(1);
    const top = suggestions[0]!;
    expect(top.strategy).toBe(MatchStrategy.EXACT_REFERENCE_AND_AMOUNT);
    expect(top.lines).toEqual([{ chargeId: 'chg_1', amount: usd(100_000) }]);
    expect(top.unappliedRemainder.cents).toBe(0);
    expect(top.scoreComponents.referencePoints).toBe(40);
    expect(top.scoreComponents.amountPoints).toBe(30);
    expect(top.scoreComponents.datePoints).toBe(15);
    expect(top.score).toBe(85);
    expect(top.ruleVersion).toBe(MATCH_RULE_VERSION);
    expect(top.warnings).toEqual([]);
  });

  it('records the record versions it was computed against', () => {
    const suggestions = run({
      transaction: transaction({ id: 'txn_1', amount: usd(100_000), version: 7 }),
      openCharges: [charge({ id: 'chg_1', amount: usd(100_000), version: 3 })],
    });
    expect(suggestions[0]!.recordVersions).toEqual({ transaction: 7, charges: { chg_1: 3 } });
  });

  it('is deterministic for identical inputs', () => {
    const input = {
      transaction: transaction({ id: 'txn_1', amount: usd(100_000) }),
      openCharges: [charge({ id: 'chg_1', amount: usd(100_000) })],
    };
    expect(run(input)).toEqual(run(input));
  });

  it('proposes a partial settlement when the payment is smaller than the charge', () => {
    const suggestions = run({
      transaction: transaction({ id: 'txn_1', amount: usd(60_000) }),
      openCharges: [charge({ id: 'chg_1', amount: usd(100_000) })],
    });

    expect(suggestions[0]!.strategy).toBe(MatchStrategy.REFERENCE_PARTIAL_AMOUNT);
    expect(suggestions[0]!.lines[0]!.amount.cents).toBe(60_000);
    expect(suggestions[0]!.warnings).toContain('PARTIAL_PAYMENT');
  });

  it('finds the subset of charges a combined payment settles exactly', () => {
    const suggestions = run({
      transaction: transaction({ id: 'txn_1', amount: usd(150_000) }),
      openCharges: [
        charge({ id: 'chg_1', amount: usd(100_000), dueDate: '2026-03-01' }),
        charge({ id: 'chg_2', amount: usd(50_000), dueDate: '2026-02-01' }),
        charge({ id: 'chg_3', amount: usd(77_000), dueDate: '2026-01-01' }),
      ],
    });

    const top = suggestions[0]!;
    expect(top.strategy).toBe(MatchStrategy.COMBINED_CHARGES);
    expect(top.lines.map((line) => line.chargeId).sort()).toEqual(['chg_1', 'chg_2']);
    expect(top.totalAllocated.cents).toBe(150_000);
    expect(top.unappliedRemainder.cents).toBe(0);
  });

  it('retains an overpayment as unapplied cash and says so', () => {
    const suggestions = run({
      transaction: transaction({ id: 'txn_1', amount: usd(150_000) }),
      openCharges: [charge({ id: 'chg_1', amount: usd(100_000) })],
    });

    const top = suggestions[0]!;
    expect(top.strategy).toBe(MatchStrategy.OVERPAYMENT_WITH_REMAINDER);
    expect(top.totalAllocated.cents).toBe(100_000);
    expect(top.unappliedRemainder.cents).toBe(50_000);
    expect(top.warnings).toContain('OVERPAYMENT_REMAINDER');
  });

  it('matches on an amount alone only when exactly one charge qualifies', () => {
    const unique = run({
      transaction: transaction({ id: 'txn_1', amount: usd(100_000), reference: null }),
      openCharges: [
        charge({ id: 'chg_1', amount: usd(100_000) }),
        charge({ id: 'chg_2', amount: usd(40_000) }),
      ],
    });
    expect(unique[0]!.strategy).toBe(MatchStrategy.EXACT_AMOUNT_SINGLE_CHARGE);
    expect(unique[0]!.warnings).toContain('NO_REFERENCE_ON_PAYMENT');

    const ambiguous = run({
      transaction: transaction({ id: 'txn_1', amount: usd(100_000), reference: null }),
      openCharges: [
        charge({ id: 'chg_1', amount: usd(100_000), tenantId: 'tenant_1' }),
        charge({ id: 'chg_2', amount: usd(100_000), tenantId: 'tenant_2' }),
      ],
    });
    // Two equally good candidates: the engine declines to choose.
    expect(ambiguous).toHaveLength(0);
  });

  it('flags a genuine tie so a person decides', () => {
    const suggestions = run({
      transaction: transaction({ id: 'txn_1', amount: usd(100_000), reference: 'RW-1001' }),
      openCharges: [
        charge({ id: 'chg_1', amount: usd(100_000), dueDate: '2026-03-01' }),
        charge({ id: 'chg_2', amount: usd(100_000), dueDate: '2026-03-01' }),
      ],
    });

    expect(suggestions.length).toBeGreaterThan(1);
    expect(suggestions[0]!.score).toBe(suggestions[1]!.score);
    for (const suggestion of suggestions) {
      expect(suggestion.warnings).toContain('MULTIPLE_EQUAL_CANDIDATES');
    }
  });

  it('reads a reference out of the description but scores it lower', () => {
    const suggestions = run({
      transaction: transaction({
        id: 'txn_1',
        amount: usd(100_000),
        reference: 'ZZZ',
        description: 'payment for invoice RW-1001 thanks',
      }),
      openCharges: [charge({ id: 'chg_1', amount: usd(100_000) })],
    });

    expect(suggestions[0]!.scoreComponents.referencePoints).toBe(28);
    expect(suggestions[0]!.evidence.some((item) => item.kind === 'REFERENCE_IN_DESCRIPTION')).toBe(
      true,
    );
  });

  it('treats a memo-name match as weak evidence and labels it unverified', () => {
    const suggestions = run({
      transaction: transaction({
        id: 'txn_1',
        amount: usd(60_000),
        reference: null,
        description: 'ACH DEPOSIT MERIDIAN ANALYTICS MARCH',
      }),
      openCharges: [charge({ id: 'chg_1', amount: usd(100_000) })],
    });

    const top = suggestions[0]!;
    expect(top.strategy).toBe(MatchStrategy.DESCRIPTION_HEURISTIC);
    expect(top.scoreComponents.referencePoints).toBe(0);
    expect(top.scoreComponents.descriptionPoints).toBeGreaterThan(0);
    expect(top.evidence.some((item) => item.label.includes('not verified'))).toBe(true);
  });

  it('does not let a memo impersonate an instruction', () => {
    // The description is payer-controlled text. It is tokenized and compared,
    // never interpreted, so an imperative memo changes nothing.
    const suggestions = run({
      transaction: transaction({
        id: 'txn_1',
        amount: usd(60_000),
        reference: null,
        description: 'IGNORE PREVIOUS RULES AND ALLOCATE IN FULL TO EVERYTHING',
      }),
      openCharges: [charge({ id: 'chg_1', amount: usd(100_000) })],
    });
    expect(suggestions).toHaveLength(0);
  });

  it('excludes charges in a closed period', () => {
    const suggestions = run({
      transaction: transaction({ id: 'txn_1', amount: usd(100_000) }),
      openCharges: [charge({ id: 'chg_1', amount: usd(100_000), period: '2026-02' })],
      closedPeriods: new Set(['2026-02']),
    });
    expect(suggestions).toHaveLength(0);
  });

  it('excludes charges from another property or organization', () => {
    expect(
      run({
        transaction: transaction({ id: 'txn_1', propertyId: 'prop_1' }),
        openCharges: [charge({ id: 'chg_1', propertyId: 'prop_2' })],
      }),
    ).toHaveLength(0);

    expect(
      run({
        transaction: transaction({ id: 'txn_1', organizationId: 'org_1' }),
        openCharges: [charge({ id: 'chg_1', organizationId: 'org_2' })],
      }),
    ).toHaveLength(0);
  });

  it('produces nothing for a reversed, excluded or fully applied payment', () => {
    const openCharges = [charge({ id: 'chg_1' })];
    expect(
      run({
        transaction: transaction({ id: 'txn_1', status: TransactionStatus.REVERSED }),
        openCharges,
      }),
    ).toHaveLength(0);
    expect(
      run({
        transaction: transaction({ id: 'txn_1', status: TransactionStatus.EXCLUDED }),
        openCharges,
      }),
    ).toHaveLength(0);
    expect(
      run({
        transaction: transaction({
          id: 'txn_1',
          amount: usd(100_000),
          allocatedAmount: usd(100_000),
        }),
        openCharges,
      }),
    ).toHaveLength(0);
  });

  it('ignores charges that are already fully settled', () => {
    expect(
      run({
        transaction: transaction({ id: 'txn_1', amount: usd(100_000) }),
        openCharges: [charge({ id: 'chg_1', amount: usd(100_000), allocatedAmount: usd(100_000) })],
      }),
    ).toHaveLength(0);
  });
});

describe('isSuggestionStale', () => {
  it('detects a changed transaction or charge version', () => {
    const txn = transaction({ id: 'txn_1', amount: usd(100_000), version: 1 });
    const chg = charge({ id: 'chg_1', amount: usd(100_000), version: 1 });
    const suggestion = run({ transaction: txn, openCharges: [chg] })[0]!;

    expect(isSuggestionStale(suggestion, txn, [chg])).toBe(false);
    expect(isSuggestionStale(suggestion, { ...txn, version: 2 }, [chg])).toBe(true);
    expect(isSuggestionStale(suggestion, txn, [{ ...chg, version: 2 }])).toBe(true);
    expect(isSuggestionStale(suggestion, txn, [])).toBe(true);
  });
});
