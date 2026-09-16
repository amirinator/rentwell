/**
 * Reconciliation matching engine.
 *
 * Produces ranked, explainable candidate allocations for one incoming payment.
 * It is deliberately a pure function: given the same transaction, the same open
 * charges and the same rule version, it returns the same suggestions. That is
 * what makes a stored suggestion reproducible during an audit.
 *
 * The score is a **ranking score**, not a probability. It orders candidates for
 * human review; it does not express a likelihood that the match is correct, and
 * the UI never renders it as a percentage confidence.
 */

import {
  add,
  compareMoney,
  isPositive,
  money,
  subtract,
  sum,
  zero,
  type CurrencyCode,
  type Money,
} from '../money/money';
import { compareLocalDate, daysBetween, type LocalDate } from '../periods/dates';
import {
  ChargeStatus,
  MatchStrategy,
  TransactionDirection,
  TransactionStatus,
  chargeOpenBalance,
  transactionOpenBalance,
  type ChargeSnapshot,
  type MatchStrategy as MatchStrategyValue,
  type TransactionSnapshot,
} from '../types';
import type { AllocationLine } from '../allocation/allocation';
import {
  extractReferenceCandidates,
  normalizeReference,
  sanitizeUntrustedText,
  sharedTokens,
  tokenSetSimilarity,
  tokenize,
} from './normalize';

/**
 * Version of the rule set. Stored on every suggestion. Bump it whenever
 * scoring weights or strategies change so historical suggestions stay
 * interpretable against the rules that produced them.
 */
export const MATCH_RULE_VERSION = '2026-09-01.1';

/** Maximum charges considered when searching for a combined-payment match. */
const COMBINATION_SEARCH_LIMIT = 10;
/** Maximum charges in one combined suggestion. */
const MAX_COMBINATION_SIZE = 5;
/** Suggestions returned per transaction, highest score first. */
export const MAX_SUGGESTIONS_PER_TRANSACTION = 5;
/** Beyond this many days between due date and payment date, date adds nothing. */
const DATE_PROXIMITY_HORIZON_DAYS = 45;

export interface TenantMatchInfo {
  readonly tenantId: string;
  readonly displayName: string;
  /** Reference printed on the tenant's invoices, if any. */
  readonly paymentReference: string | null;
  /** Per-lease references, which may differ from the tenant-level one. */
  readonly leaseReferences: readonly { leaseId: string; paymentReference: string | null }[];
}

export type EvidenceKind =
  | 'REFERENCE_EXACT'
  | 'REFERENCE_IN_DESCRIPTION'
  | 'AMOUNT_EXACT'
  | 'AMOUNT_COVERS_SUBSET'
  | 'AMOUNT_PARTIAL'
  | 'AMOUNT_EXCEEDS_OPEN'
  | 'DATE_PROXIMITY'
  | 'DESCRIPTION_TOKENS'
  | 'SINGLE_OPEN_CHARGE';

export interface MatchEvidence {
  readonly kind: EvidenceKind;
  /** Short human-readable claim. Rendered verbatim in the workbench. */
  readonly label: string;
  /** Record ids backing the claim, so a reviewer can open them. */
  readonly recordIds: readonly string[];
  /** Points this evidence contributed to the ranking score. */
  readonly contribution: number;
}

/**
 * Points contributed by each matching signal.
 *
 * Named `*Points` rather than `reference` / `amount` / `date` so that nothing
 * in a financial schema reads as a monetary value at a glance. These are
 * ranking points out of 100; none of them is money.
 */
export interface ScoreComponents {
  readonly referencePoints: number;
  readonly amountPoints: number;
  readonly datePoints: number;
  readonly descriptionPoints: number;
  readonly totalPoints: number;
}

export type SuggestionWarning =
  | 'MULTIPLE_EQUAL_CANDIDATES'
  | 'NO_REFERENCE_ON_PAYMENT'
  | 'OVERPAYMENT_REMAINDER'
  | 'PARTIAL_PAYMENT'
  | 'PAYMENT_PREDATES_DUE_DATE'
  | 'CHARGE_IN_CLOSED_PERIOD';

export interface MatchSuggestion {
  /** Stable identity of the proposal, used to detect duplicates on re-run. */
  readonly fingerprint: string;
  readonly transactionId: string;
  readonly strategy: MatchStrategyValue;
  readonly lines: readonly AllocationLine[];
  readonly totalAllocated: Money;
  /** Payment value left unapplied if this suggestion is approved as proposed. */
  readonly unappliedRemainder: Money;
  readonly score: number;
  readonly scoreComponents: ScoreComponents;
  readonly evidence: readonly MatchEvidence[];
  readonly warnings: readonly SuggestionWarning[];
  readonly ruleVersion: string;
  /** Versions the suggestion was computed against; rechecked at approval. */
  readonly recordVersions: {
    readonly transaction: number;
    readonly charges: Readonly<Record<string, number>>;
  };
  readonly generatedAt: string;
}

export interface MatchEngineInput {
  readonly transaction: TransactionSnapshot;
  /** Open charges for the same organization, property and currency. */
  readonly openCharges: readonly ChargeSnapshot[];
  /** Tenant reference data, keyed by tenant id. */
  readonly tenants: ReadonlyMap<string, TenantMatchInfo>;
  /** Periods that are closed for this property; charges there cannot be paid. */
  readonly closedPeriods?: ReadonlySet<string>;
  /** Injected for determinism in tests. Defaults to the current time. */
  readonly now?: Date;
}

/** No suggestions are produced for these transaction states. */
function isMatchable(transaction: TransactionSnapshot): boolean {
  return (
    transaction.direction === TransactionDirection.CREDIT &&
    transaction.status !== TransactionStatus.REVERSED &&
    transaction.status !== TransactionStatus.EXCLUDED &&
    transactionOpenBalance(transaction).cents > 0
  );
}

function isPayable(charge: ChargeSnapshot, closedPeriods: ReadonlySet<string>): boolean {
  return (
    charge.status !== ChargeStatus.VOIDED &&
    chargeOpenBalance(charge).cents > 0 &&
    !closedPeriods.has(charge.period)
  );
}

// --------------------------------------------------------------------------
// Score components. Weights are documented in docs/reconciliation-rules.md.
// --------------------------------------------------------------------------

const WEIGHT_REFERENCE_EXACT = 40;
const WEIGHT_REFERENCE_IN_DESCRIPTION = 28;
const WEIGHT_AMOUNT_EXACT = 30;
const WEIGHT_AMOUNT_SUBSET = 24;
const WEIGHT_AMOUNT_PARTIAL = 12;
const WEIGHT_AMOUNT_OVER = 10;
const WEIGHT_DATE_MAX = 15;
const WEIGHT_DESCRIPTION_MAX = 10;
const WEIGHT_SINGLE_OPEN_CHARGE = 6;

/**
 * Date proximity score: full marks when the payment lands on or within a few
 * days of the due date, decaying linearly to zero at the horizon. Early
 * payments score the same as equally-distant late ones.
 */
function dateProximityScore(dueDate: LocalDate, postedDate: LocalDate): number {
  const distance = Math.abs(daysBetween(dueDate, postedDate));
  if (distance >= DATE_PROXIMITY_HORIZON_DAYS) return 0;
  const ratio = 1 - distance / DATE_PROXIMITY_HORIZON_DAYS;
  return roundScore(WEIGHT_DATE_MAX * ratio);
}

/** Scores are stored to one decimal place so two runs compare byte-identically. */
function roundScore(value: number): number {
  return Number(value.toFixed(1));
}

// --------------------------------------------------------------------------
// Reference resolution
// --------------------------------------------------------------------------

interface ReferenceHit {
  readonly tenantId: string;
  readonly matchedReference: string;
  readonly source: 'REFERENCE_FIELD' | 'DESCRIPTION';
}

/**
 * Builds a lookup from normalized reference to tenant. A reference claimed by
 * more than one tenant is dropped: an ambiguous reference is worse than none,
 * because it would produce a confident-looking wrong suggestion.
 */
function buildReferenceIndex(
  tenants: ReadonlyMap<string, TenantMatchInfo>,
): Map<string, string | null> {
  const index = new Map<string, string | null>();
  const register = (reference: string | null, tenantId: string): void => {
    const normalized = normalizeReference(reference);
    if (normalized.length < 3) return;
    if (!index.has(normalized)) {
      index.set(normalized, tenantId);
      return;
    }
    if (index.get(normalized) !== tenantId) index.set(normalized, null);
  };

  for (const tenant of tenants.values()) {
    register(tenant.paymentReference, tenant.tenantId);
    for (const lease of tenant.leaseReferences) register(lease.paymentReference, tenant.tenantId);
  }
  return index;
}

function resolveReference(
  transaction: TransactionSnapshot,
  index: ReadonlyMap<string, string | null>,
): ReferenceHit | null {
  const fromField = normalizeReference(transaction.reference);
  if (fromField.length >= 3) {
    const tenantId = index.get(fromField);
    if (tenantId) return { tenantId, matchedReference: fromField, source: 'REFERENCE_FIELD' };
  }

  for (const candidate of extractReferenceCandidates(transaction.description)) {
    const tenantId = index.get(candidate);
    if (tenantId) return { tenantId, matchedReference: candidate, source: 'DESCRIPTION' };
  }

  return null;
}

/**
 * Tenants whose display name shares distinctive tokens with the memo. Used only
 * when no reference resolves, and always ranked below reference-backed matches.
 */
function resolveByDescription(
  transaction: TransactionSnapshot,
  tenants: ReadonlyMap<string, TenantMatchInfo>,
): { tenantId: string; similarity: number; shared: string[] }[] {
  const memoTokens = tokenize(transaction.description);
  if (memoTokens.length === 0) return [];

  const scored: { tenantId: string; similarity: number; shared: string[] }[] = [];
  for (const tenant of tenants.values()) {
    const nameTokens = tokenize(tenant.displayName);
    const similarity = tokenSetSimilarity(memoTokens, nameTokens);
    if (similarity <= 0) continue;
    const shared = sharedTokens(nameTokens, memoTokens);
    if (shared.length === 0) continue;
    scored.push({ tenantId: tenant.tenantId, similarity, shared });
  }

  return scored
    .sort((a, b) =>
      b.similarity === a.similarity
        ? a.tenantId.localeCompare(b.tenantId)
        : b.similarity - a.similarity,
    )
    .slice(0, 3);
}

// --------------------------------------------------------------------------
// Subset search
// --------------------------------------------------------------------------

/**
 * Finds a subset of charges whose open balances sum exactly to `target`.
 *
 * Bounded exhaustive search over at most COMBINATION_SEARCH_LIMIT charges,
 * preferring fewer charges and then earlier due dates. Exhaustive rather than
 * greedy because a greedy fill misses the common case of a tenant paying two
 * specific invoices and skipping a third of similar size.
 */
function findExactSubset(
  charges: readonly ChargeSnapshot[],
  target: Money,
): ChargeSnapshot[] | null {
  const pool = [...charges]
    .sort((a, b) => {
      const byDue = compareLocalDate(a.dueDate, b.dueDate);
      return byDue !== 0 ? byDue : a.id.localeCompare(b.id);
    })
    .slice(0, COMBINATION_SEARCH_LIMIT);

  let best: ChargeSnapshot[] | null = null;
  const current: ChargeSnapshot[] = [];

  const search = (startIndex: number, remainingCents: number): void => {
    if (remainingCents === 0 && current.length > 0) {
      if (best === null || current.length < best.length) best = [...current];
      return;
    }
    if (remainingCents < 0) return;
    if (current.length >= MAX_COMBINATION_SIZE) return;
    if (best !== null && current.length + 1 >= best.length) return;

    for (let i = startIndex; i < pool.length; i += 1) {
      const charge = pool[i]!;
      const open = chargeOpenBalance(charge).cents;
      if (open <= 0 || open > remainingCents) continue;
      current.push(charge);
      search(i + 1, remainingCents - open);
      current.pop();
    }
  };

  search(0, target.cents);
  return best;
}

// --------------------------------------------------------------------------
// Suggestion assembly
// --------------------------------------------------------------------------

interface DraftSuggestion {
  readonly strategy: MatchStrategyValue;
  readonly charges: readonly ChargeSnapshot[];
  readonly lines: readonly AllocationLine[];
  readonly evidence: MatchEvidence[];
  readonly warnings: SuggestionWarning[];
  readonly referenceScore: number;
  readonly amountScore: number;
  readonly descriptionScore: number;
}

function fingerprintOf(
  transactionId: string,
  strategy: MatchStrategyValue,
  lines: readonly AllocationLine[],
): string {
  const linePart = [...lines]
    .map((line) => `${line.chargeId}:${line.amount.cents}`)
    .sort()
    .join(',');
  return `${transactionId}|${strategy}|${linePart}`;
}

function finalize(
  draft: DraftSuggestion,
  transaction: TransactionSnapshot,
  currency: CurrencyCode,
  generatedAt: string,
): MatchSuggestion {
  const totalAllocated =
    draft.lines.length === 0
      ? zero(currency)
      : sum(
          draft.lines.map((line) => line.amount),
          currency,
        );
  const unappliedRemainder = subtract(transactionOpenBalance(transaction), totalAllocated);

  // Date score uses the earliest due date among the charges in the suggestion,
  // which is the one an accountant would expect the payment to settle first.
  const earliestDue = draft.charges.reduce<LocalDate | null>((acc, charge) => {
    if (acc === null) return charge.dueDate;
    return compareLocalDate(charge.dueDate, acc) < 0 ? charge.dueDate : acc;
  }, null);
  const dateScore =
    earliestDue === null ? 0 : dateProximityScore(earliestDue, transaction.postedDate);

  const evidence = [...draft.evidence];
  if (dateScore > 0 && earliestDue !== null) {
    const distance = daysBetween(earliestDue, transaction.postedDate);
    evidence.push({
      kind: 'DATE_PROXIMITY',
      label:
        distance === 0
          ? `Paid on the due date ${earliestDue}`
          : distance > 0
            ? `Paid ${distance} day(s) after the ${earliestDue} due date`
            : `Paid ${Math.abs(distance)} day(s) before the ${earliestDue} due date`,
      recordIds: draft.charges.map((charge) => charge.id),
      contribution: dateScore,
    });
  }

  const warnings = [...draft.warnings];
  if (earliestDue !== null && compareLocalDate(transaction.postedDate, earliestDue) < 0) {
    warnings.push('PAYMENT_PREDATES_DUE_DATE');
  }
  if (unappliedRemainder.cents > 0 && draft.strategy !== MatchStrategy.REFERENCE_PARTIAL_AMOUNT) {
    warnings.push('OVERPAYMENT_REMAINDER');
  }

  const components: ScoreComponents = {
    referencePoints: roundScore(draft.referenceScore),
    amountPoints: roundScore(draft.amountScore),
    datePoints: dateScore,
    descriptionPoints: roundScore(draft.descriptionScore),
    totalPoints: roundScore(
      draft.referenceScore + draft.amountScore + dateScore + draft.descriptionScore,
    ),
  };

  const chargeVersions: Record<string, number> = {};
  for (const charge of draft.charges) chargeVersions[charge.id] = charge.version;

  return {
    fingerprint: fingerprintOf(transaction.id, draft.strategy, draft.lines),
    transactionId: transaction.id,
    strategy: draft.strategy,
    lines: draft.lines,
    totalAllocated,
    unappliedRemainder,
    score: components.totalPoints,
    scoreComponents: components,
    evidence,
    warnings: [...new Set(warnings)],
    ruleVersion: MATCH_RULE_VERSION,
    recordVersions: { transaction: transaction.version, charges: chargeVersions },
    generatedAt,
  };
}

function lineFor(charge: ChargeSnapshot, amount: Money): AllocationLine {
  return { chargeId: charge.id, amount };
}

/**
 * Generates ranked suggestions for one transaction.
 *
 * Ordering is by score descending, then by strategy name and fingerprint, so
 * the list is stable across runs and two equally-scored candidates never swap
 * places between a preview and an approval.
 */
export function generateSuggestions(input: MatchEngineInput): MatchSuggestion[] {
  const { transaction } = input;
  const currency = transaction.currency;
  const generatedAt = (input.now ?? new Date()).toISOString();
  const closedPeriods = input.closedPeriods ?? new Set<string>();

  if (!isMatchable(transaction)) return [];

  const available = transactionOpenBalance(transaction);
  const payable = input.openCharges.filter(
    (charge) =>
      charge.organizationId === transaction.organizationId &&
      charge.propertyId === transaction.propertyId &&
      charge.currency === currency &&
      isPayable(charge, closedPeriods),
  );
  if (payable.length === 0) return [];

  const referenceIndex = buildReferenceIndex(input.tenants);
  const referenceHit = resolveReference(transaction, referenceIndex);
  const drafts: DraftSuggestion[] = [];

  if (referenceHit) {
    drafts.push(...draftsForTenant(referenceHit, payable, available, transaction));
  } else {
    // No usable reference: fall back to amount identity and memo tokens, and
    // say so, because an unreferenced payment is an exception candidate.
    drafts.push(...draftsWithoutReference(payable, available, transaction, input.tenants));
  }

  const suggestions = drafts
    .filter((draft) => draft.lines.length > 0)
    .map((draft) => finalize(draft, transaction, currency, generatedAt));

  // Deduplicate: two strategies can land on the same line set.
  const byFingerprint = new Map<string, MatchSuggestion>();
  for (const suggestion of suggestions) {
    const existing = byFingerprint.get(suggestion.fingerprint);
    if (!existing || suggestion.score > existing.score) {
      byFingerprint.set(suggestion.fingerprint, suggestion);
    }
  }

  const ranked = [...byFingerprint.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const byStrategy = a.strategy.localeCompare(b.strategy);
    return byStrategy !== 0 ? byStrategy : a.fingerprint.localeCompare(b.fingerprint);
  });

  // Flag a genuine tie at the top: the accountant must choose, not the engine.
  if (ranked.length > 1 && ranked[0]!.score === ranked[1]!.score) {
    return ranked.slice(0, MAX_SUGGESTIONS_PER_TRANSACTION).map((suggestion) => ({
      ...suggestion,
      warnings: [...new Set([...suggestion.warnings, 'MULTIPLE_EQUAL_CANDIDATES' as const])],
    }));
  }

  return ranked.slice(0, MAX_SUGGESTIONS_PER_TRANSACTION);
}

function draftsForTenant(
  hit: ReferenceHit,
  payable: readonly ChargeSnapshot[],
  available: Money,
  transaction: TransactionSnapshot,
): DraftSuggestion[] {
  const tenantCharges = payable.filter((charge) => charge.tenantId === hit.tenantId);
  if (tenantCharges.length === 0) return [];

  const referenceScore =
    hit.source === 'REFERENCE_FIELD' ? WEIGHT_REFERENCE_EXACT : WEIGHT_REFERENCE_IN_DESCRIPTION;
  const referenceEvidence: MatchEvidence = {
    kind: hit.source === 'REFERENCE_FIELD' ? 'REFERENCE_EXACT' : 'REFERENCE_IN_DESCRIPTION',
    label:
      hit.source === 'REFERENCE_FIELD'
        ? `Payment reference ${hit.matchedReference} matches this tenant`
        : `Reference ${hit.matchedReference} found in the payment description`,
    recordIds: [hit.tenantId, transaction.id],
    contribution: referenceScore,
  };

  const drafts: DraftSuggestion[] = [];
  const byDueDate = [...tenantCharges].sort((a, b) => {
    const byDue = compareLocalDate(a.dueDate, b.dueDate);
    return byDue !== 0 ? byDue : a.id.localeCompare(b.id);
  });

  // 1. Exactly one charge matching the payment amount.
  const exact = byDueDate.filter((charge) => chargeOpenBalance(charge).cents === available.cents);
  for (const charge of exact.slice(0, 2)) {
    drafts.push({
      strategy: MatchStrategy.EXACT_REFERENCE_AND_AMOUNT,
      charges: [charge],
      lines: [lineFor(charge, available)],
      evidence: [
        referenceEvidence,
        {
          kind: 'AMOUNT_EXACT',
          label: `Payment amount equals the full open balance of this charge`,
          recordIds: [charge.id],
          contribution: WEIGHT_AMOUNT_EXACT,
        },
      ],
      warnings: [],
      referenceScore,
      amountScore: WEIGHT_AMOUNT_EXACT,
      descriptionScore: 0,
    });
  }

  // 2. A subset of charges summing exactly to the payment.
  if (exact.length === 0 && byDueDate.length > 1) {
    const subset = findExactSubset(byDueDate, available);
    if (subset && subset.length > 1) {
      drafts.push({
        strategy: MatchStrategy.COMBINED_CHARGES,
        charges: subset,
        lines: subset.map((charge) => lineFor(charge, chargeOpenBalance(charge))),
        evidence: [
          referenceEvidence,
          {
            kind: 'AMOUNT_COVERS_SUBSET',
            label: `Payment equals the combined open balance of ${subset.length} charges`,
            recordIds: subset.map((charge) => charge.id),
            contribution: WEIGHT_AMOUNT_SUBSET,
          },
        ],
        warnings: [],
        referenceScore,
        amountScore: WEIGHT_AMOUNT_SUBSET,
        descriptionScore: 0,
      });
    }
  }

  const totalOpen = sum(
    byDueDate.map((charge) => chargeOpenBalance(charge)),
    transaction.currency,
  );

  // 3. Payment smaller than the oldest charge: a partial settlement.
  if (exact.length === 0 && compareMoney(available, totalOpen) < 0) {
    const oldest = byDueDate[0]!;
    const oldestOpen = chargeOpenBalance(oldest);
    const applied = compareMoney(available, oldestOpen) <= 0 ? available : oldestOpen;
    if (isPositive(applied)) {
      const lines: AllocationLine[] = [lineFor(oldest, applied)];
      const charges: ChargeSnapshot[] = [oldest];
      let remaining = subtract(available, applied);

      // Spill into the next charges by due date, oldest first.
      for (const charge of byDueDate.slice(1)) {
        if (remaining.cents <= 0) break;
        const open = chargeOpenBalance(charge);
        const take = money(Math.min(remaining.cents, open.cents), transaction.currency);
        if (take.cents <= 0) continue;
        lines.push(lineFor(charge, take));
        charges.push(charge);
        remaining = subtract(remaining, take);
      }

      drafts.push({
        strategy: MatchStrategy.REFERENCE_PARTIAL_AMOUNT,
        charges,
        lines,
        evidence: [
          referenceEvidence,
          {
            kind: 'AMOUNT_PARTIAL',
            label: `Payment covers part of ${charges.length} outstanding charge(s), oldest first`,
            recordIds: charges.map((charge) => charge.id),
            contribution: WEIGHT_AMOUNT_PARTIAL,
          },
        ],
        warnings: ['PARTIAL_PAYMENT'],
        referenceScore,
        amountScore: WEIGHT_AMOUNT_PARTIAL,
        descriptionScore: 0,
      });
    }
  }

  // 4. Payment exceeds everything outstanding: settle all, retain the rest.
  if (compareMoney(available, totalOpen) > 0 && isPositive(totalOpen)) {
    const lines = byDueDate
      .map((charge) => lineFor(charge, chargeOpenBalance(charge)))
      .filter((line) => line.amount.cents > 0);
    drafts.push({
      strategy: MatchStrategy.OVERPAYMENT_WITH_REMAINDER,
      charges: byDueDate,
      lines,
      evidence: [
        referenceEvidence,
        {
          kind: 'AMOUNT_EXCEEDS_OPEN',
          label: `Payment exceeds all outstanding charges; the remainder stays as unapplied cash`,
          recordIds: byDueDate.map((charge) => charge.id),
          contribution: WEIGHT_AMOUNT_OVER,
        },
      ],
      warnings: ['OVERPAYMENT_REMAINDER'],
      referenceScore,
      amountScore: WEIGHT_AMOUNT_OVER,
      descriptionScore: 0,
    });
  }

  return drafts;
}

function draftsWithoutReference(
  payable: readonly ChargeSnapshot[],
  available: Money,
  transaction: TransactionSnapshot,
  tenants: ReadonlyMap<string, TenantMatchInfo>,
): DraftSuggestion[] {
  const drafts: DraftSuggestion[] = [];
  const baseWarnings: SuggestionWarning[] = ['NO_REFERENCE_ON_PAYMENT'];

  // Amount identity across the whole property. Only proposed when exactly one
  // charge matches, otherwise the choice belongs to the accountant.
  const exact = payable.filter((charge) => chargeOpenBalance(charge).cents === available.cents);
  if (exact.length === 1) {
    const charge = exact[0]!;
    drafts.push({
      strategy: MatchStrategy.EXACT_AMOUNT_SINGLE_CHARGE,
      charges: [charge],
      lines: [lineFor(charge, available)],
      evidence: [
        {
          kind: 'AMOUNT_EXACT',
          label: 'Exactly one open charge in this property matches the payment amount',
          recordIds: [charge.id],
          contribution: WEIGHT_AMOUNT_EXACT,
        },
        {
          kind: 'SINGLE_OPEN_CHARGE',
          label: 'No other open charge has this balance',
          recordIds: [charge.id],
          contribution: WEIGHT_SINGLE_OPEN_CHARGE,
        },
      ],
      warnings: baseWarnings,
      referenceScore: 0,
      amountScore: WEIGHT_AMOUNT_EXACT + WEIGHT_SINGLE_OPEN_CHARGE,
      descriptionScore: 0,
    });
  }

  // Memo tokens resembling a tenant name. Scored low and always accompanied by
  // the tokens that matched, so the reviewer can dismiss a coincidence.
  for (const candidate of resolveByDescription(transaction, tenants)) {
    const tenantCharges = payable.filter((charge) => charge.tenantId === candidate.tenantId);
    if (tenantCharges.length === 0) continue;

    const ordered = [...tenantCharges].sort((a, b) => {
      const byDue = compareLocalDate(a.dueDate, b.dueDate);
      return byDue !== 0 ? byDue : a.id.localeCompare(b.id);
    });

    const lines: AllocationLine[] = [];
    const charges: ChargeSnapshot[] = [];
    let remaining = available;
    for (const charge of ordered) {
      if (remaining.cents <= 0) break;
      const open = chargeOpenBalance(charge);
      const take = money(Math.min(remaining.cents, open.cents), transaction.currency);
      if (take.cents <= 0) continue;
      lines.push(lineFor(charge, take));
      charges.push(charge);
      remaining = subtract(remaining, take);
    }
    if (lines.length === 0) continue;

    const descriptionScore = roundScore(WEIGHT_DESCRIPTION_MAX * candidate.similarity);
    drafts.push({
      strategy: MatchStrategy.DESCRIPTION_HEURISTIC,
      charges,
      lines,
      evidence: [
        {
          kind: 'DESCRIPTION_TOKENS',
          label: `Payment description shares the words ${candidate.shared
            .map((token) => `"${token}"`)
            .join(
              ', ',
            )} with the tenant name. Description text is supplied by the payer and is not verified.`,
          recordIds: [candidate.tenantId, transaction.id],
          contribution: descriptionScore,
        },
      ],
      warnings: baseWarnings,
      referenceScore: 0,
      amountScore: 0,
      descriptionScore,
    });
  }

  return drafts;
}

/**
 * True when a stored suggestion was computed against record versions that have
 * since changed. Callers turn this into a STALE_RECORD conflict rather than
 * approving against balances the reviewer never saw.
 */
export function isSuggestionStale(
  suggestion: MatchSuggestion,
  transaction: TransactionSnapshot,
  charges: readonly ChargeSnapshot[],
): boolean {
  if (suggestion.recordVersions.transaction !== transaction.version) return true;
  const byId = new Map(charges.map((charge) => [charge.id, charge]));
  for (const [chargeId, version] of Object.entries(suggestion.recordVersions.charges)) {
    const charge = byId.get(chargeId);
    if (!charge || charge.version !== version) return true;
  }
  return false;
}

/** Redacted transaction text for display alongside a suggestion. */
export function describeTransactionForReview(transaction: TransactionSnapshot): string {
  const reference = transaction.reference
    ? `ref ${sanitizeUntrustedText(transaction.reference, 64)}`
    : 'no reference';
  const description = sanitizeUntrustedText(transaction.description, 200);
  return description ? `${reference} - ${description}` : reference;
}

/** Sum of active allocations implied by a suggestion, for preview totals. */
export function suggestionTotal(suggestion: MatchSuggestion): Money {
  return suggestion.lines.reduce<Money>(
    (acc, line) => add(acc, line.amount),
    zero(suggestion.totalAllocated.currency),
  );
}
