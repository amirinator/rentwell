import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  SimulatedBankingProvider,
  createBankingProvider,
  createRandom,
  isSupportedProvider,
  type ProviderAccount,
  type ProviderWebhookEvent,
  type SimulatorTransactionSeed,
  type TransactionPage,
} from '../src/index';

const ACCOUNTS: ProviderAccount[] = [
  {
    providerAccountId: 'acct_main',
    displayName: 'Operating account',
    maskedNumber: '4821',
    currency: 'USD',
  },
];

function seeds(count: number): SimulatorTransactionSeed[] {
  return Array.from({ length: count }, (_, index) => ({
    externalId: `sim_${String(index).padStart(4, '0')}`,
    providerAccountId: 'acct_main',
    amountCents: 100_000 + index * 137,
    currency: 'USD',
    postedDate: '2026-03-05',
    reference: `RW-${1000 + index}`,
    description: 'ACH credit',
  }));
}

function provider(
  overrides: Partial<ConstructorParameters<typeof SimulatedBankingProvider>[0]> = {},
) {
  return new SimulatedBankingProvider({
    seed: 'test-seed',
    accounts: ACCOUNTS,
    transactions: seeds(40),
    webhookSecret: 'shhh',
    pageSize: 10,
    ...overrides,
  });
}

/** Retries a retryable provider failure on the same cursor, as the worker does. */
async function fetchWithRetry(
  bank: SimulatedBankingProvider,
  cursor: string | null,
): Promise<TransactionPage> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await bank.fetchTransactions({ cursor });
    } catch (error) {
      lastError = error;
      if (error instanceof ProviderError && error.retryable) continue;
      throw error;
    }
  }
  throw lastError;
}

async function drain(bank: SimulatedBankingProvider, maxPages = 60) {
  const delivered: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  for (;;) {
    if (pages >= maxPages) throw new Error('simulator did not terminate');
    const page = await fetchWithRetry(bank, cursor);
    pages += 1;
    for (const txn of page.transactions) delivered.push(txn.externalId);
    cursor = page.nextCursor;
    if (!page.hasMore || cursor === null) break;
  }

  return { delivered, pages };
}

describe('createRandom', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = createRandom('abc');
    const b = createRandom('abc');
    const c = createRandom('xyz');

    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
  });

  it('stays inside [0, 1)', () => {
    const random = createRandom('range');
    for (let i = 0; i < 500; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('SimulatedBankingProvider', () => {
  it('lists the configured accounts and never exposes a full number', async () => {
    const accounts = await provider().listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.maskedNumber).toHaveLength(4);
  });

  it('delivers every transaction exactly once when chaos is disabled', async () => {
    const bank = provider({ deterministicCleanStream: true });
    const { delivered } = await drain(bank);

    expect(delivered).toHaveLength(40);
    expect(new Set(delivered).size).toBe(40);
    expect(delivered).toEqual(seeds(40).map((seed) => seed.externalId));
  });

  it('produces the same stream twice for the same seed', async () => {
    const first = await drain(provider());
    const second = await drain(provider());
    expect(second.delivered).toEqual(first.delivered);
  });

  it('eventually delivers every transaction even with duplicates and late arrivals', async () => {
    const bank = provider({ duplicateRate: 0.5, lateRate: 0.5, failureRate: 0 });
    const { delivered } = await drain(bank);

    // Duplicates mean more deliveries than transactions...
    expect(delivered.length).toBeGreaterThanOrEqual(40);
    // ...but nothing is lost, which is the property the ingestion worker relies on.
    expect(new Set(delivered).size).toBe(40);
  });

  it('delivers at least one duplicate at a high duplicate rate', async () => {
    const bank = provider({ duplicateRate: 1, lateRate: 0, failureRate: 0 });
    const { delivered } = await drain(bank);
    expect(delivered.length).toBeGreaterThan(new Set(delivered).size);
  });

  it('delivers a held-back transaction out of posted-date order', async () => {
    const bank = provider({ lateRate: 1, duplicateRate: 0, failureRate: 0, pageSize: 5 });
    const first = await bank.fetchTransactions({ cursor: null });

    // Everything on the first page was held back, so the page is empty but the
    // stream is still open.
    expect(first.transactions).toHaveLength(0);
    expect(first.hasMore).toBe(true);

    const second = await bank.fetchTransactions({ cursor: first.nextCursor });
    expect(second.transactions.length).toBeGreaterThan(0);
    expect(second.transactions.every((txn) => txn.raw.deliveredLate === true)).toBe(true);
  });

  it('fails a page transiently and succeeds on retry', async () => {
    const bank = provider({ failureRate: 1, duplicateRate: 0, lateRate: 0 });

    await expect(bank.fetchTransactions({ cursor: null })).rejects.toBeInstanceOf(ProviderError);
    const retry = await bank.fetchTransactions({ cursor: null });
    expect(retry.transactions.length).toBeGreaterThan(0);
  });

  it('marks a transient failure as retryable and a bad cursor as not', async () => {
    const bank = provider({ failureRate: 1 });
    await bank.fetchTransactions({ cursor: null }).catch((error: ProviderError) => {
      expect(error.retryable).toBe(true);
    });

    await expect(bank.fetchTransactions({ cursor: 'not-a-cursor' })).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('carries a reversal reference through unchanged', async () => {
    const bank = provider({
      deterministicCleanStream: true,
      transactions: [
        ...seeds(1),
        {
          externalId: 'sim_reversal',
          providerAccountId: 'acct_main',
          amountCents: -100_000,
          currency: 'USD',
          postedDate: '2026-03-09',
          reference: 'RW-1000',
          description: 'Returned item',
          reversesExternalId: 'sim_0000',
        },
      ],
    });

    const page = await bank.fetchTransactions({ cursor: null });
    const reversal = page.transactions.find((txn) => txn.externalId === 'sim_reversal');
    expect(reversal!.reversesExternalId).toBe('sim_0000');
    expect(reversal!.amountCents).toBe(-100_000);
  });
});

describe('webhook handling', () => {
  const bank = provider();

  const event: ProviderWebhookEvent = {
    eventId: 'evt_1',
    eventType: 'transaction.created',
    occurredAt: '2026-03-05T12:00:00.000Z',
    transaction: {
      externalId: 'sim_0000',
      providerAccountId: 'acct_main',
      amountCents: 100_000,
      currency: 'USD',
      postedDate: '2026-03-05',
      valueDate: '2026-03-05',
      reference: 'RW-1000',
      description: 'ACH credit',
      reversesExternalId: null,
      raw: {},
    },
  };

  it('accepts a correctly signed delivery', () => {
    const { body, signature } = bank.buildWebhookDelivery(event);
    const parsed = bank.parseWebhook(body, signature);
    expect(parsed.eventId).toBe('evt_1');
    expect(parsed.transaction.externalId).toBe('sim_0000');
  });

  it('rejects a missing signature', () => {
    const { body } = bank.buildWebhookDelivery(event);
    expect(() => bank.parseWebhook(body, undefined)).toThrow(ProviderError);
  });

  it('rejects a tampered body', () => {
    const { body, signature } = bank.buildWebhookDelivery(event);
    const tampered = body.replace('100000', '999999');
    expect(() => bank.parseWebhook(tampered, signature)).toThrow(/signature does not match/);
  });

  it('rejects a signature of the wrong length without throwing on comparison', () => {
    const { body } = bank.buildWebhookDelivery(event);
    expect(() => bank.parseWebhook(body, 'short')).toThrow(/signature does not match/);
  });

  it('rejects a malformed body even when correctly signed', () => {
    const body = '{"eventId":"evt_2","eventType":"nope"}';
    expect(() => bank.parseWebhook(body, bank.signWebhook(body))).toThrow(
      /Unsupported webhook event type/,
    );
  });

  it('rejects a body that is not JSON', () => {
    const body = 'not json at all';
    expect(() => bank.parseWebhook(body, bank.signWebhook(body))).toThrow(/not valid JSON/);
  });
});

describe('provider registry', () => {
  it('builds the simulator', () => {
    const bank = createBankingProvider({
      name: 'simulator',
      simulator: {
        seed: 's',
        accounts: ACCOUNTS,
        transactions: [],
        webhookSecret: 'x',
      },
    });
    expect(bank.name).toBe('simulator');
  });

  it('refuses an unknown provider name', () => {
    expect(() => createBankingProvider({ name: 'plaid' })).toThrow(/only the simulator/);
    expect(isSupportedProvider('plaid')).toBe(false);
    expect(isSupportedProvider('simulator')).toBe(true);
  });

  it('refuses the simulator without a configuration', () => {
    expect(() => createBankingProvider({ name: 'simulator' })).toThrow(ProviderError);
  });
});
