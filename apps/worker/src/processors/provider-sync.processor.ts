/**
 * Banking provider synchronisation.
 *
 * Pulls pages of transactions from the provider adapter and ingests them.
 *
 * The rule that makes this safe: **the sync cursor advances only after the page
 * it came from is durably processed.** A crash between processing a page and
 * saving its cursor replays that page, and replaying is harmless because
 * ingestion deduplicates on the provider's own external id. The opposite
 * ordering — saving the cursor first — would silently skip a page of payments,
 * which is the failure mode this ordering exists to prevent.
 */

import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, DomainError, isDomainError, periodOf, systemContext } from '@rentwell/domain';
import { recordAuditEvent } from '@rentwell/database';
import {
  ProviderError,
  createBankingProvider,
  type BankingProvider,
  type ProviderTransaction,
} from '@rentwell/integrations';
import type { Logger } from '@rentwell/observability';
import { ExceptionsService, PrismaService, TransactionsService } from '@rentwell/api/modules';
import { TransactionIngestService } from '../ingest/transaction-ingest.service';
import { WORKER_CONFIG, WORKER_LOGGER } from '../tokens';
import type { WorkerConfig } from '../config';
import type { ProviderSyncJobData } from '../queues';

const CONSUMER = 'provider-sync';
/** Hard ceiling on pages per run, so one job cannot run unbounded. */
const MAX_PAGES_PER_RUN = 200;

export interface SyncSummary {
  readonly pages: number;
  readonly created: number;
  readonly duplicates: number;
  readonly reversals: number;
  readonly conflicts: number;
}

@Injectable()
export class ProviderSyncProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: TransactionIngestService,
    private readonly transactions: TransactionsService,
    private readonly exceptions: ExceptionsService,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(WORKER_LOGGER) private readonly logger: Logger,
  ) {}

  async process(data: ProviderSyncJobData): Promise<SyncSummary> {
    const log = this.logger.child({
      connectionId: data.connectionId,
      correlationId: data.correlationId ?? undefined,
    });

    const connection = await this.prisma.client.integrationConnection.findUnique({
      where: { id: data.connectionId },
      include: {
        bankAccounts: {
          where: { isActive: true },
          select: { id: true, providerAccountId: true, propertyId: true, currency: true },
        },
      },
    });

    if (!connection) {
      log.warn('Integration connection no longer exists');
      return { pages: 0, created: 0, duplicates: 0, reversals: 0, conflicts: 0 };
    }

    const provider = this.buildProvider(connection.provider, connection.settings);
    const accountsByProviderId = new Map(
      connection.bankAccounts
        .filter((account) => account.providerAccountId !== null)
        .map((account) => [account.providerAccountId!, account]),
    );

    const summary = { pages: 0, created: 0, duplicates: 0, reversals: 0, conflicts: 0 };
    let cursor = connection.syncCursor;

    try {
      for (;;) {
        if (summary.pages >= MAX_PAGES_PER_RUN) {
          log.warn(
            { pages: summary.pages },
            'Stopping sync at the page ceiling; requeue to continue',
          );
          break;
        }

        const page = await provider.fetchTransactions({
          cursor,
          pageSize: this.config.bank.syncPageSize,
        });
        summary.pages += 1;

        for (const transaction of page.transactions) {
          const outcome = await this.applyOne(
            connection.organizationId,
            accountsByProviderId,
            transaction,
            data.correlationId,
            log,
          );
          if (outcome === 'CREATED') summary.created += 1;
          else if (outcome === 'DUPLICATE') summary.duplicates += 1;
          else if (outcome === 'REVERSAL') summary.reversals += 1;
          else if (outcome === 'CONFLICT') summary.conflicts += 1;
        }

        // Only now, with the whole page durably applied, does the cursor move.
        cursor = page.nextCursor;
        await this.prisma.client.integrationConnection.update({
          where: { id: connection.id },
          data: { syncCursor: cursor, lastSyncedAt: new Date(), lastErrorMessage: null },
        });

        if (!page.hasMore || cursor === null) break;
      }

      await recordAuditEvent(this.prisma.client, {
        organizationId: connection.organizationId,
        propertyId: null,
        actorUserId: null,
        actorSystem: CONSUMER,
        action: AuditAction.PROVIDER_SYNC_COMPLETED,
        entityType: 'IntegrationConnection',
        entityId: connection.id,
        metadata: { ...summary },
        correlationId: data.correlationId,
        occurredAt: new Date(),
      });

      log.info({ ...summary }, 'Provider sync completed');
      return summary;
    } catch (error) {
      await this.prisma.client.integrationConnection
        .update({
          where: { id: connection.id },
          data: {
            lastErrorAt: new Date(),
            lastErrorMessage:
              error instanceof Error ? error.message.slice(0, 500) : 'Unknown provider failure',
          },
        })
        .catch(() => undefined);

      // A retryable provider failure is rethrown so BullMQ backs off; the
      // cursor is unchanged, so the retry re-fetches the page that failed.
      if (error instanceof ProviderError && error.retryable) throw error;
      if (error instanceof ProviderError) {
        log.error({ err: error }, 'Provider rejected the request; not retrying');
        return summary;
      }
      throw error;
    }
  }

  /**
   * Applies one provider transaction.
   *
   * A reversal is routed to the reversal path, which unwinds allocations before
   * the receipt. A reversal naming a payment we never received becomes an
   * integration conflict for a person to resolve rather than being ignored.
   */
  private async applyOne(
    organizationId: string,
    accounts: ReadonlyMap<string, { id: string; propertyId: string; currency: string }>,
    transaction: ProviderTransaction,
    correlationId: string | null,
    log: Logger,
  ): Promise<'CREATED' | 'DUPLICATE' | 'REVERSAL' | 'CONFLICT' | 'SKIPPED'> {
    const account = accounts.get(transaction.providerAccountId);
    if (!account) {
      log.warn(
        { providerAccountId: transaction.providerAccountId },
        'Provider returned a transaction for an account Rentwell does not hold',
      );
      return 'SKIPPED';
    }

    if (transaction.reversesExternalId) {
      return this.applyReversal(organizationId, account, transaction, correlationId, log);
    }

    const result = await this.prisma.run((tx) =>
      this.ingest.ingest(tx, {
        organizationId,
        propertyId: account.propertyId,
        bankAccountId: account.id,
        correlationId,
        payment: {
          providerKey: 'simulator',
          externalId: transaction.externalId,
          amountCents: transaction.amountCents,
          currency: transaction.currency,
          postedDate: transaction.postedDate,
          valueDate: transaction.valueDate,
          reference: transaction.reference,
          description: transaction.description,
          source: 'PROVIDER_SYNC',
          raw: { ...transaction.raw },
        },
      }),
    );

    if (result.outcome === 'CREATED') return 'CREATED';
    if (result.outcome === 'DUPLICATE') return 'DUPLICATE';
    if (result.outcome === 'CONFLICT') return 'CONFLICT';
    return 'SKIPPED';
  }

  private async applyReversal(
    organizationId: string,
    account: { id: string; propertyId: string },
    transaction: ProviderTransaction,
    correlationId: string | null,
    log: Logger,
  ): Promise<'REVERSAL' | 'CONFLICT'> {
    const target = await this.prisma.client.bankTransaction.findUnique({
      where: {
        bankAccountId_providerKey_externalId: {
          bankAccountId: account.id,
          providerKey: 'simulator',
          externalId: transaction.reversesExternalId!,
        },
      },
      select: { id: true },
    });

    const access = systemContext(organizationId);

    if (!target) {
      // The provider reversed something we never received. Silently ignoring it
      // would hide a real integration problem, so it becomes a blocking
      // exception a person has to look at.
      await this.prisma.run((tx) =>
        this.exceptions.openOrUpdate(tx, {
          access,
          propertyId: account.propertyId,
          transactionId: null,
          tenantId: null,
          category: 'INTEGRATION_CONFLICT',
          severity: 'CRITICAL',
          summary: `The provider reversed payment ${transaction.reversesExternalId}, which Rentwell has never received.`,
          openAmountCents: Math.abs(transaction.amountCents),
          currency: transaction.currency.trim().toUpperCase(),
          period: periodOf(transaction.postedDate),
          correlationId,
          actorSystem: CONSUMER,
        }),
      );

      log.error(
        { reversesExternalId: transaction.reversesExternalId },
        'Provider reversed an unknown payment',
      );
      return 'CONFLICT';
    }

    try {
      await this.prisma.run((tx) =>
        this.transactions.applyProviderReversal(tx, access, {
          transactionId: target.id,
          reason: `Provider reversal ${transaction.externalId}`,
          correlationId,
          actorSystem: CONSUMER,
        }),
      );
      return 'REVERSAL';
    } catch (error) {
      if (isDomainError(error) && error.code === 'PERIOD_CLOSED') {
        // The period the receipt belongs to is closed. That is a decision for a
        // controller, not something a worker should force.
        log.warn({ transactionId: target.id }, 'Reversal targets a closed period');
        return 'CONFLICT';
      }
      throw error;
    }
  }

  private buildProvider(name: string, settings: unknown): BankingProvider {
    const parsed = (settings ?? {}) as {
      accounts?: unknown;
      transactions?: unknown;
    };

    try {
      return createBankingProvider({
        name,
        simulator: {
          seed: this.config.bank.simulatorSeed,
          webhookSecret: this.config.bank.webhookSecret,
          pageSize: this.config.bank.syncPageSize,
          // The demo fixture writes the account and transaction set into the
          // connection's settings, so the simulator replays exactly the stream
          // the seed created.
          accounts: Array.isArray(parsed.accounts) ? (parsed.accounts as never) : [],
          transactions: Array.isArray(parsed.transactions) ? (parsed.transactions as never) : [],
        },
      });
    } catch (error) {
      throw new DomainError('PROVIDER_ERROR', `Could not build the ${name} provider adapter`, {
        cause: error,
      });
    }
  }
}

/**
 * Like the import job, this consumer does not claim the event in
 * `ProcessedEvent`.
 *
 * A sync spans many pages and many transactions, so a claim taken up front
 * would survive a mid-sync failure and make the retry skip the remaining pages.
 * The cursor is what makes a retry correct instead: it advances only behind
 * durably processed work, so a retry re-fetches at worst one page, and
 * ingestion deduplicates the re-fetched records on the provider's external id.
 */
