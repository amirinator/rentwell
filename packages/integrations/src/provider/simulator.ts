/**
 * Deterministic banking provider simulator.
 *
 * This is the only provider shipped in the public repository. It exists to
 * exercise the failure modes a real integration produces, on demand and without
 * credentials:
 *
 *   - the same transaction delivered twice (duplicate delivery),
 *   - a transaction that arrives days after its posted date (late arrival),
 *   - a page fetch that fails once and succeeds on retry (transient failure),
 *   - events delivered out of order,
 *   - a reversal of an earlier payment,
 *   - a reversal naming a transaction that was never delivered.
 *
 * Every behaviour is driven by a seeded PRNG, so a given seed always produces
 * the same stream. That is what lets the demo, the integration tests and the
 * browser tests assert on exact outcomes.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { addDays, type LocalDate } from '@rentwell/domain';
import {
  ProviderError,
  type BankingProvider,
  type FetchOptions,
  type ProviderAccount,
  type ProviderTransaction,
  type ProviderWebhookEvent,
  type TransactionPage,
} from './types';

/**
 * Mulberry32. Small, fast, and — the property that matters here — identical
 * across Node versions and platforms, unlike `Math.random`.
 */
export function createRandom(seed: string): () => number {
  let state = 0;
  for (let i = 0; i < seed.length; i += 1) {
    state = (state * 31 + seed.charCodeAt(i)) >>> 0;
  }
  if (state === 0) state = 0x9e3779b9;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulatorTransactionSeed {
  readonly externalId: string;
  readonly providerAccountId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly postedDate: LocalDate;
  readonly reference: string | null;
  readonly description: string | null;
  /** Marks this record as a reversal of an earlier external id. */
  readonly reversesExternalId?: string | null;
}

export interface SimulatorConfig {
  readonly seed: string;
  readonly accounts: readonly ProviderAccount[];
  readonly transactions: readonly SimulatorTransactionSeed[];
  readonly webhookSecret: string;
  /** Probability that a page repeats one of its own transactions. */
  readonly duplicateRate?: number;
  /** Probability that a transaction is held back and delivered later. */
  readonly lateRate?: number;
  /** Probability that a fetch fails transiently before returning. */
  readonly failureRate?: number;
  readonly pageSize?: number;
  /** Disables all injected chaos. Used by tests that need a clean stream. */
  readonly deterministicCleanStream?: boolean;
}

interface CursorState {
  readonly offset: number;
  /** Transactions held back from earlier pages, to be delivered here. */
  readonly deferred: readonly string[];
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): CursorState {
  if (!cursor) return { offset: 0, deferred: [] };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorState;
    if (typeof parsed.offset !== 'number' || !Array.isArray(parsed.deferred)) {
      throw new Error('malformed');
    }
    return { offset: parsed.offset, deferred: parsed.deferred };
  } catch {
    throw new ProviderError('Sync cursor is not valid for this provider', 'simulator', false);
  }
}

export class SimulatedBankingProvider implements BankingProvider {
  readonly name = 'simulator';

  private readonly config: SimulatorConfig;
  private readonly byExternalId: Map<string, SimulatorTransactionSeed>;
  /** Fetch attempts per cursor, so an injected failure clears on retry. */
  private readonly attemptsByCursor = new Map<string, number>();

  constructor(config: SimulatorConfig) {
    this.config = config;
    this.byExternalId = new Map(config.transactions.map((item) => [item.externalId, item]));
  }

  async listAccounts(): Promise<readonly ProviderAccount[]> {
    return this.config.accounts;
  }

  async fetchTransactions(options: FetchOptions = {}): Promise<TransactionPage> {
    const cursorKey = options.cursor ?? '';
    const state = decodeCursor(options.cursor);
    const pageSize = options.pageSize ?? this.config.pageSize ?? 100;
    const clean = this.config.deterministicCleanStream === true;

    const attempt = (this.attemptsByCursor.get(cursorKey) ?? 0) + 1;
    this.attemptsByCursor.set(cursorKey, attempt);

    // Deterministic transient failure: fails the first attempt for a cursor,
    // then succeeds, so a retry policy is exercised without an infinite loop.
    if (!clean && attempt === 1) {
      const random = createRandom(`${this.config.seed}:fail:${cursorKey}`);
      if (random() < (this.config.failureRate ?? 0.05)) {
        throw new ProviderError('Provider is temporarily unavailable (simulated)', this.name, true);
      }
    }

    const all = this.config.transactions;
    const slice = all.slice(state.offset, state.offset + pageSize);

    const delivered: ProviderTransaction[] = [];
    const deferredNow: string[] = [];

    // Deliver anything held back from an earlier page first. This is the
    // out-of-order case: a transaction with an older posted date arrives after
    // newer ones.
    for (const externalId of state.deferred) {
      const seed = this.byExternalId.get(externalId);
      if (seed) delivered.push(this.toTransaction(seed, { late: true }));
    }

    for (const seed of slice) {
      const random = createRandom(`${this.config.seed}:${seed.externalId}`);

      if (!clean && random() < (this.config.lateRate ?? 0.06)) {
        deferredNow.push(seed.externalId);
        continue;
      }

      delivered.push(this.toTransaction(seed, { late: false }));

      // Duplicate delivery: the same record twice in one page. The ingestion
      // worker must create one payment, not two.
      if (!clean && random() < (this.config.duplicateRate ?? 0.08)) {
        delivered.push(this.toTransaction(seed, { late: false, duplicate: true }));
      }
    }

    const nextOffset = state.offset + slice.length;
    const exhausted = nextOffset >= all.length;

    // Hold the stream open while anything is still deferred, so a late
    // transaction is never lost at the end of a sync.
    const hasMore = !exhausted || deferredNow.length > 0;
    const nextCursor = hasMore ? encodeCursor({ offset: nextOffset, deferred: deferredNow }) : null;

    return { transactions: delivered, nextCursor, hasMore };
  }

  private toTransaction(
    seed: SimulatorTransactionSeed,
    flags: { late: boolean; duplicate?: boolean },
  ): ProviderTransaction {
    return {
      externalId: seed.externalId,
      providerAccountId: seed.providerAccountId,
      amountCents: seed.amountCents,
      currency: seed.currency,
      postedDate: seed.postedDate,
      // A late arrival keeps its original posted date; only the delivery is
      // late. Rewriting the date would hide the very case being simulated.
      valueDate: flags.late ? addDays(seed.postedDate, 2) : seed.postedDate,
      reference: seed.reference,
      description: seed.description,
      reversesExternalId: seed.reversesExternalId ?? null,
      raw: Object.freeze({
        provider: this.name,
        simulated: true,
        deliveredLate: flags.late,
        duplicateDelivery: flags.duplicate === true,
        seed: this.config.seed,
      }),
    };
  }

  /** Signs a payload the way the simulator's webhooks are signed. */
  signWebhook(rawBody: string): string {
    return createHmac('sha256', this.config.webhookSecret).update(rawBody).digest('hex');
  }

  parseWebhook(rawBody: string, signature: string | undefined): ProviderWebhookEvent {
    if (!signature) {
      throw new ProviderError('Webhook delivery has no signature', this.name, false);
    }

    const expected = this.signWebhook(rawBody);
    const provided = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');

    // Length check first: timingSafeEqual throws on a length mismatch.
    if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
      throw new ProviderError('Webhook signature does not match', this.name, false);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new ProviderError('Webhook body is not valid JSON', this.name, false);
    }

    return normalizeWebhookEvent(parsed, this.name);
  }

  /** Builds a signed delivery, for tests and the demo webhook endpoint. */
  buildWebhookDelivery(event: ProviderWebhookEvent): { body: string; signature: string } {
    const body = JSON.stringify(event);
    return { body, signature: this.signWebhook(body) };
  }
}

function normalizeWebhookEvent(parsed: unknown, provider: string): ProviderWebhookEvent {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProviderError('Webhook body is not an object', provider, false);
  }

  const body = parsed as Record<string, unknown>;
  const eventId = body.eventId;
  const eventType = body.eventType;
  const transaction = body.transaction;

  if (typeof eventId !== 'string' || eventId.length === 0) {
    throw new ProviderError('Webhook is missing eventId', provider, false);
  }
  if (
    eventType !== 'transaction.created' &&
    eventType !== 'transaction.updated' &&
    eventType !== 'transaction.reversed'
  ) {
    throw new ProviderError(
      `Unsupported webhook event type: ${String(eventType)}`,
      provider,
      false,
    );
  }
  if (typeof transaction !== 'object' || transaction === null) {
    throw new ProviderError('Webhook is missing a transaction', provider, false);
  }

  const txn = transaction as Record<string, unknown>;
  if (typeof txn.externalId !== 'string' || typeof txn.amountCents !== 'number') {
    throw new ProviderError('Webhook transaction is malformed', provider, false);
  }

  return {
    eventId,
    eventType,
    occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : new Date().toISOString(),
    transaction: {
      externalId: txn.externalId,
      providerAccountId: String(txn.providerAccountId ?? ''),
      amountCents: txn.amountCents,
      currency: String(txn.currency ?? 'USD'),
      postedDate: String(txn.postedDate ?? '') as LocalDate,
      valueDate: typeof txn.valueDate === 'string' ? (txn.valueDate as LocalDate) : null,
      reference: typeof txn.reference === 'string' ? txn.reference : null,
      description: typeof txn.description === 'string' ? txn.description : null,
      reversesExternalId:
        typeof txn.reversesExternalId === 'string' ? txn.reversesExternalId : null,
      raw: Object.freeze({ ...txn }),
    },
  };
}
