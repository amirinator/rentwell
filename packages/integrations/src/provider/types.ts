/**
 * The banking provider contract.
 *
 * Everything the reconciliation domain sees from a bank arrives through this
 * interface. Provider-specific payloads never reach a charge, allocation or
 * journal entry: an adapter normalises them into the shapes below and keeps the
 * original in `raw`, which is stored on the transaction for support purposes
 * and read by nothing that computes money.
 *
 * This is what makes the simulator a genuine stand-in for a real provider
 * rather than a shortcut: swapping the adapter changes no domain code.
 */

import type { LocalDate } from '@rentwell/domain';

export interface ProviderAccount {
  /** The provider's identifier for the account. Stable across syncs. */
  readonly providerAccountId: string;
  readonly displayName: string;
  /** Last four digits only. Adapters must not surface a full account number. */
  readonly maskedNumber: string;
  readonly currency: string;
}

export interface ProviderTransaction {
  /** The provider's own identifier. The deduplication key, with the account. */
  readonly externalId: string;
  readonly providerAccountId: string;
  /** Positive for money in, negative for money out. */
  readonly amountCents: number;
  readonly currency: string;
  readonly postedDate: LocalDate;
  readonly valueDate: LocalDate | null;
  readonly reference: string | null;
  /** Payer-supplied text. Untrusted. */
  readonly description: string | null;
  /**
   * Set when this record reverses an earlier one. The adapter reports the
   * provider's claim; Rentwell decides whether the target actually exists.
   */
  readonly reversesExternalId: string | null;
  /** The provider's untouched payload, for support and replay. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface TransactionPage {
  readonly transactions: readonly ProviderTransaction[];
  /**
   * Cursor for the next page, or null at the end of the stream.
   *
   * Rentwell only persists a cursor after the page it came from is durably
   * processed, so a crash mid-page replays that page rather than skipping it.
   */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface FetchOptions {
  readonly cursor?: string | null;
  readonly pageSize?: number;
}

export type ProviderEventType =
  'transaction.created' | 'transaction.updated' | 'transaction.reversed';

export interface ProviderWebhookEvent {
  /** The provider's event identifier. Deduplicated on receipt. */
  readonly eventId: string;
  readonly eventType: ProviderEventType;
  readonly occurredAt: string;
  readonly transaction: ProviderTransaction;
}

/** Signals an adapter-level failure, classified so callers know whether to retry. */
export class ProviderError extends Error {
  readonly code = 'PROVIDER_ERROR';
  constructor(
    message: string,
    readonly provider: string,
    /** True for timeouts, rate limits and 5xx: retrying may succeed. */
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    // Passed through to the standard `Error.cause` rather than shadowed by a
    // parameter property, so the original failure survives and tooling that
    // walks the cause chain still works.
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProviderError';
  }
}

export interface BankingProvider {
  readonly name: string;

  listAccounts(): Promise<readonly ProviderAccount[]>;

  /** Fetches one page of transactions from `cursor`, oldest first. */
  fetchTransactions(options: FetchOptions): Promise<TransactionPage>;

  /**
   * Verifies a webhook signature and parses the body.
   *
   * Throws `ProviderError` when the signature does not match, so an unsigned or
   * forged delivery is rejected before anything reads its contents.
   */
  parseWebhook(rawBody: string, signature: string | undefined): ProviderWebhookEvent;
}
