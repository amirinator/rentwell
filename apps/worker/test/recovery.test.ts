/**
 * Worker recovery.
 *
 * These test the pieces of the worker whose correctness is about failure, not
 * about the happy path: what a crash costs, what a redelivery costs, and what
 * happens when retries run out.
 *
 * They exercise the real queue helpers and the real provider simulator against
 * in-memory state, so they need no database. The database-backed halves of the
 * same properties — the checkpoint, the unique indexes — are covered by
 * `apps/api/test/integration/concurrency.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  SimulatedBankingProvider,
  type ProviderAccount,
  type SimulatorTransactionSeed,
  type TransactionPage,
} from '@rentwell/integrations';
import { DEFAULT_JOB_OPTIONS, deterministicJobId } from '../src/queues';

const ACCOUNTS: ProviderAccount[] = [
  {
    providerAccountId: 'acct_main',
    displayName: 'Operating',
    maskedNumber: '4821',
    currency: 'USD',
  },
];

function seeds(count: number): SimulatorTransactionSeed[] {
  return Array.from({ length: count }, (_, index) => ({
    externalId: `sim_${String(index).padStart(4, '0')}`,
    providerAccountId: 'acct_main',
    amountCents: 100_000 + index,
    currency: 'USD',
    postedDate: '2026-03-05',
    reference: `RW-${1000 + index}`,
    description: 'ACH credit',
  }));
}

/**
 * Drains the provider exactly as the sync processor does: retrying a retryable
 * failure on the *same* cursor, and advancing only after the page is processed.
 */
async function syncLikeTheWorker(
  bank: SimulatedBankingProvider,
  options: { crashAfterPages?: number; startCursor?: string | null } = {},
): Promise<{ ingested: string[]; cursor: string | null; pages: number }> {
  const ingested: string[] = [];
  let cursor = options.startCursor ?? null;
  let pages = 0;

  for (;;) {
    if (options.crashAfterPages !== undefined && pages >= options.crashAfterPages) {
      // Simulates the process dying before the next page is persisted.
      return { ingested, cursor, pages };
    }

    let page: TransactionPage | null = null;
    for (let attempt = 0; attempt < 4 && page === null; attempt += 1) {
      try {
        page = await bank.fetchTransactions({ cursor });
      } catch (error) {
        if (error instanceof ProviderError && error.retryable) continue;
        throw error;
      }
    }
    if (page === null) throw new Error('retries exhausted');

    for (const transaction of page.transactions) ingested.push(transaction.externalId);

    // Only now does the cursor move.
    cursor = page.nextCursor;
    pages += 1;

    if (!page.hasMore || cursor === null) break;
  }

  return { ingested, cursor, pages };
}

describe('crash after a committed page', () => {
  it('resuming from the saved cursor loses nothing', async () => {
    const config = {
      seed: 'recovery',
      accounts: ACCOUNTS,
      transactions: seeds(30),
      webhookSecret: 'x',
      pageSize: 10,
      deterministicCleanStream: true,
    };

    // Crash after two pages.
    const first = await syncLikeTheWorker(new SimulatedBankingProvider(config), {
      crashAfterPages: 2,
    });
    expect(first.ingested).toHaveLength(20);
    expect(first.cursor).not.toBeNull();

    // A fresh process resumes from the persisted cursor.
    const second = await syncLikeTheWorker(new SimulatedBankingProvider(config), {
      startCursor: first.cursor,
    });

    const all = [...first.ingested, ...second.ingested];
    expect(new Set(all).size).toBe(30);
    expect(all).toHaveLength(30);
  });

  it('a crash before the cursor is saved replays the page rather than skipping it', async () => {
    const config = {
      seed: 'replay',
      accounts: ACCOUNTS,
      transactions: seeds(20),
      webhookSecret: 'x',
      pageSize: 10,
      deterministicCleanStream: true,
    };

    // The worker processed page one but died before persisting its cursor, so
    // it restarts from null.
    const attempt = await syncLikeTheWorker(new SimulatedBankingProvider(config), {
      crashAfterPages: 1,
    });
    const restart = await syncLikeTheWorker(new SimulatedBankingProvider(config), {
      startCursor: null,
    });

    // The first page is delivered twice. That is the correct trade: replaying
    // is harmless because ingestion deduplicates, whereas skipping would lose
    // ten payments undetectably.
    const combined = [...attempt.ingested, ...restart.ingested];
    expect(combined.length).toBeGreaterThan(20);
    expect(new Set(combined).size).toBe(20);
  });
});

describe('duplicate provider events', () => {
  it('a duplicate-heavy stream still delivers every transaction exactly once by id', async () => {
    const bank = new SimulatedBankingProvider({
      seed: 'dupes',
      accounts: ACCOUNTS,
      transactions: seeds(25),
      webhookSecret: 'x',
      pageSize: 10,
      duplicateRate: 1,
      lateRate: 0,
      failureRate: 0,
    });

    const { ingested } = await syncLikeTheWorker(bank);

    // More deliveries than transactions...
    expect(ingested.length).toBeGreaterThan(25);
    // ...but the set is complete, which is what the unique index relies on.
    expect(new Set(ingested).size).toBe(25);
  });

  it('a late arrival is delivered, not dropped', async () => {
    const bank = new SimulatedBankingProvider({
      seed: 'late',
      accounts: ACCOUNTS,
      transactions: seeds(20),
      webhookSecret: 'x',
      pageSize: 5,
      lateRate: 1,
      duplicateRate: 0,
      failureRate: 0,
    });

    const { ingested } = await syncLikeTheWorker(bank);

    // Every held-back transaction eventually arrives, including the ones
    // deferred from the final page.
    expect(new Set(ingested).size).toBe(20);
  });
});

describe('transient failures', () => {
  it('a retryable failure is retried on the same cursor and then succeeds', async () => {
    const bank = new SimulatedBankingProvider({
      seed: 'flaky',
      accounts: ACCOUNTS,
      transactions: seeds(15),
      webhookSecret: 'x',
      pageSize: 5,
      failureRate: 1,
      duplicateRate: 0,
      lateRate: 0,
    });

    const { ingested } = await syncLikeTheWorker(bank);
    expect(new Set(ingested).size).toBe(15);
  });

  it('a non-retryable failure is not retried', async () => {
    const bank = new SimulatedBankingProvider({
      seed: 'bad-cursor',
      accounts: ACCOUNTS,
      transactions: seeds(5),
      webhookSecret: 'x',
    });

    await expect(bank.fetchTransactions({ cursor: 'not-a-cursor' })).rejects.toMatchObject({
      retryable: false,
    });
  });
});

describe('retry policy', () => {
  it('bounds attempts and keeps failed jobs long enough to inspect', () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(5);
    expect(DEFAULT_JOB_OPTIONS.backoff).toMatchObject({ type: 'exponential' });

    // Failed jobs are kept far longer than completed ones, because those are
    // the ones an operator needs to look at.
    const removeOnFail = DEFAULT_JOB_OPTIONS.removeOnFail as { age: number };
    const removeOnComplete = DEFAULT_JOB_OPTIONS.removeOnComplete as { age: number };
    expect(removeOnFail.age).toBeGreaterThan(removeOnComplete.age);
  });

  it('derives a stable job id from an event id so a repeated dispatch collapses', () => {
    expect(deterministicJobId('import', 'evt-1')).toBe('import:evt-1');
    expect(deterministicJobId('import', 'evt-1')).toBe(deterministicJobId('import', 'evt-1'));
    expect(deterministicJobId('import', 'evt-1')).not.toBe(deterministicJobId('sync', 'evt-1'));
  });
});

describe('webhook signatures', () => {
  it('rejects a forged delivery before the body is interpreted', () => {
    const bank = new SimulatedBankingProvider({
      seed: 'hooks',
      accounts: ACCOUNTS,
      transactions: [],
      webhookSecret: 'the-secret',
    });

    const body = JSON.stringify({
      eventId: 'evt-1',
      eventType: 'transaction.reversed',
      transaction: { externalId: 'sim_0000', amountCents: -100 },
    });

    expect(() => bank.parseWebhook(body, 'forged')).toThrow(/signature does not match/);
    expect(() => bank.parseWebhook(body, undefined)).toThrow(/no signature/);

    // Correctly signed, it parses.
    const parsed = bank.parseWebhook(body, bank.signWebhook(body));
    expect(parsed.eventId).toBe('evt-1');
    expect(parsed.eventType).toBe('transaction.reversed');
  });
});
