/**
 * Turning an incoming payment record into a posted receipt.
 *
 * Both ingestion paths — a CSV row and a provider transaction — land here, so
 * a payment behaves identically however it arrived.
 *
 * The properties that matter:
 *
 *  - **Created once.** `(bankAccountId, providerKey, externalId)` is unique, so
 *    a duplicate delivery, a re-run batch or a retried job produces one payment.
 *    A duplicate is reported as a duplicate, not swallowed silently.
 *  - **A conflicting repeat is an error.** The same external id arriving with a
 *    different amount or date is not a duplicate; it is a provider
 *    inconsistency, and it raises an integration exception.
 *  - **Receipt and posting commit together.** The payment row, its journal
 *    entry, its suggestions and any exception are written in one transaction.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  DomainError,
  OutboxEventType,
  buildPaymentReceivedEntry,
  money,
  periodOf,
  systemContext,
  type AccessContext,
  type LedgerAccountCode,
  type LocalDate,
} from '@rentwell/domain';
import {
  centsFromDb,
  centsToDb,
  enqueueOutboxEvent,
  ensureLedgerAccounts,
  isUniqueViolation,
  localDateToDb,
  lockPeriodForPosting,
  recordAuditEvent,
  toJson,
  toTransactionSnapshot,
  writeJournalEntry,
  type PrismaTransaction,
  type TransactionRow,
} from '@rentwell/database';
import { PrismaService, ExceptionsService, SuggestionsService } from '@rentwell/api/modules';
import type { Logger } from '@rentwell/observability';
import { WORKER_LOGGER } from '../tokens';

export type IngestOutcome = 'CREATED' | 'DUPLICATE' | 'CONFLICT' | 'SKIPPED';

export interface IncomingPayment {
  readonly providerKey: string;
  readonly externalId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly postedDate: LocalDate;
  readonly valueDate: LocalDate | null;
  readonly reference: string | null;
  readonly description: string | null;
  readonly source: 'CSV_IMPORT' | 'PROVIDER_SYNC' | 'PROVIDER_WEBHOOK' | 'MANUAL';
  readonly raw: Record<string, unknown>;
  readonly importBatchId?: string | null;
  /** External id of the payment this one reverses, if the provider said so. */
  readonly reversesExternalId?: string | null;
}

export interface IngestResult {
  readonly outcome: IngestOutcome;
  readonly transactionId: string | null;
  readonly message: string | null;
}

@Injectable()
export class TransactionIngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exceptions: ExceptionsService,
    private readonly suggestions: SuggestionsService,
    @Inject(WORKER_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Ingests one payment inside the caller's transaction.
   *
   * Runs in the caller's transaction so a batch of rows either all commit with
   * their checkpoint or all roll back, which is what makes a crashed import
   * resumable rather than half-applied.
   */
  async ingest(
    tx: PrismaTransaction,
    params: {
      organizationId: string;
      propertyId: string;
      bankAccountId: string;
      payment: IncomingPayment;
      correlationId: string | null;
    },
  ): Promise<IngestResult> {
    const { payment } = params;
    const access = systemContext(params.organizationId);

    const bankAccount = await tx.bankAccount.findFirst({
      where: { id: params.bankAccountId, organizationId: params.organizationId },
      select: { id: true, currency: true, propertyId: true },
    });
    if (!bankAccount) {
      throw new DomainError('NOT_FOUND', 'Bank account not found', {
        details: { bankAccountId: params.bankAccountId },
      });
    }

    const accountCurrency = bankAccount.currency.trim();
    const paymentCurrency = payment.currency.trim().toUpperCase();

    // An existing record with this external id is either a duplicate (same
    // financial values) or a provider inconsistency. They are not the same
    // thing and must not be treated the same way.
    const existing = await tx.bankTransaction.findUnique({
      where: {
        bankAccountId_providerKey_externalId: {
          bankAccountId: bankAccount.id,
          providerKey: payment.providerKey,
          externalId: payment.externalId,
        },
      },
      select: {
        id: true,
        amountCents: true,
        postedDate: true,
        currency: true,
        propertyId: true,
        period: true,
      },
    });

    if (existing) {
      const sameAmount = centsFromDb(existing.amountCents) === payment.amountCents;
      const sameDate = existing.postedDate.toISOString().slice(0, 10) === payment.postedDate;
      const sameCurrency = existing.currency.trim() === paymentCurrency;

      if (sameAmount && sameDate && sameCurrency) {
        return {
          outcome: 'DUPLICATE',
          transactionId: existing.id,
          message: 'Already ingested; no new payment was created.',
        };
      }

      await this.exceptions.openOrUpdate(tx, {
        access,
        propertyId: existing.propertyId,
        transactionId: existing.id,
        tenantId: null,
        category: 'INTEGRATION_CONFLICT',
        severity: 'CRITICAL',
        summary:
          `External id ${payment.externalId} arrived again with different values ` +
          `(${payment.amountCents} cents on ${payment.postedDate} versus ` +
          `${centsFromDb(existing.amountCents)} cents on ${existing.postedDate.toISOString().slice(0, 10)}).`,
        openAmountCents: 0,
        currency: existing.currency.trim(),
        period: existing.period,
        correlationId: params.correlationId,
        actorSystem: 'ingestion-worker',
      });

      return {
        outcome: 'CONFLICT',
        transactionId: existing.id,
        message: 'The same external id arrived with different financial values.',
      };
    }

    // Cross-currency is rejected rather than converted: version 1 has no rate
    // source, and inventing one would be worse than refusing.
    if (paymentCurrency !== accountCurrency) {
      const period = periodOf(payment.postedDate);
      await this.exceptions.openOrUpdate(tx, {
        access,
        propertyId: bankAccount.propertyId,
        transactionId: null,
        tenantId: null,
        category: 'CURRENCY_MISMATCH',
        severity: 'HIGH',
        summary: `A ${paymentCurrency} payment arrived on a ${accountCurrency} account and was not ingested.`,
        openAmountCents: 0,
        currency: accountCurrency,
        period,
        correlationId: params.correlationId,
        actorSystem: 'ingestion-worker',
      });

      return {
        outcome: 'SKIPPED',
        transactionId: null,
        message: `Payment is in ${paymentCurrency}; the account is ${accountCurrency}.`,
      };
    }

    const postingDate = payment.postedDate;
    const period = periodOf(postingDate);

    // Lock the period, then check it. A close committing right now either wins
    // or is queued behind this.
    await lockPeriodForPosting(tx, params.organizationId, bankAccount.propertyId, period);

    let transactionId: string;
    try {
      const created = await tx.bankTransaction.create({
        data: {
          organizationId: params.organizationId,
          propertyId: bankAccount.propertyId,
          bankAccountId: bankAccount.id,
          importBatchId: payment.importBatchId ?? null,
          source: payment.source,
          providerKey: payment.providerKey,
          externalId: payment.externalId,
          direction: payment.amountCents >= 0 ? 'CREDIT' : 'DEBIT',
          status: 'UNAPPLIED',
          currency: paymentCurrency,
          // Stored as the absolute value with the direction in its own column,
          // so a sign error cannot turn a refund into a receipt.
          amountCents: centsToDb(Math.abs(payment.amountCents)),
          postedDate: localDateToDb(payment.postedDate),
          postingDate: localDateToDb(postingDate),
          period,
          valueDate: payment.valueDate ? localDateToDb(payment.valueDate) : null,
          reference: payment.reference,
          description: payment.description,
          providerPayload: toJson(payment.raw),
        },
        select: { id: true },
      });
      transactionId = created.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Another worker ingested it between the lookup and the insert.
        const row = await tx.bankTransaction.findUnique({
          where: {
            bankAccountId_providerKey_externalId: {
              bankAccountId: bankAccount.id,
              providerKey: payment.providerKey,
              externalId: payment.externalId,
            },
          },
          select: { id: true },
        });
        return {
          outcome: 'DUPLICATE',
          transactionId: row?.id ?? null,
          message: 'Ingested concurrently by another worker.',
        };
      }
      throw error;
    }

    // Money out is recorded for completeness but never posted as a receipt or
    // allocated: only incoming money settles a receivable.
    if (payment.amountCents > 0) {
      const accountIds = await ensureLedgerAccounts(tx, params.organizationId);
      await ensureReceiptPosted(tx, {
        accountIds,
        transactionId,
        organizationId: params.organizationId,
        propertyId: bankAccount.propertyId,
        amountCents: payment.amountCents,
        currency: paymentCurrency,
        postingDate,
        valueDate: payment.valueDate ?? payment.postedDate,
        description: payment.description ?? `Payment ${payment.externalId}`,
        correlationId: params.correlationId,
      });

      await this.generateSuggestionsAndException(
        tx,
        access,
        transactionId,
        period,
        params.correlationId,
      );
    }

    await recordAuditEvent(tx, {
      organizationId: params.organizationId,
      propertyId: bankAccount.propertyId,
      actorUserId: null,
      actorSystem: 'ingestion-worker',
      action: AuditAction.PROVIDER_SYNC_COMPLETED,
      entityType: 'BankTransaction',
      entityId: transactionId,
      metadata: {
        source: payment.source,
        externalId: payment.externalId,
        amountCents: payment.amountCents,
        period,
      },
      correlationId: params.correlationId,
      occurredAt: new Date(),
    });

    await enqueueOutboxEvent(tx, {
      organizationId: params.organizationId,
      eventType: OutboxEventType.TRANSACTION_INGESTED,
      partitionKey: transactionId,
      payload: { transactionId, propertyId: bankAccount.propertyId },
      correlationId: params.correlationId,
    });

    return { outcome: 'CREATED', transactionId, message: null };
  }

  /**
   * Generates suggestions and, when the payment still cannot be reconciled,
   * opens an exception describing why.
   *
   * Done inside the ingestion transaction so a payment is never visible without
   * the explanation of what is wrong with it.
   */
  private async generateSuggestionsAndException(
    tx: PrismaTransaction,
    access: AccessContext,
    transactionId: string,
    period: string,
    correlationId: string | null,
  ): Promise<void> {
    const suggestions = await this.suggestions.generateFor(
      tx,
      access,
      transactionId,
      correlationId,
    );

    const row = await tx.bankTransaction.findUniqueOrThrow({ where: { id: transactionId } });
    const snapshot = toTransactionSnapshot(row as unknown as TransactionRow);

    const hasTie = suggestions.length > 1 && suggestions[0]!.score === suggestions[1]!.score;

    // A payment with exactly one unambiguous, reference-backed suggestion is
    // left for review without an exception: the accountant has a clear
    // proposal, which is not a discrepancy.
    const confident =
      suggestions.length === 1 &&
      !hasTie &&
      suggestions[0]!.scoreComponents.referencePoints > 0 &&
      suggestions[0]!.unappliedRemainder.cents === 0;

    if (confident) return;

    const duplicate = await this.findProbableDuplicate(tx, row);

    await this.exceptions.classifyAndOpen(tx, {
      access,
      transaction: snapshot,
      propertyId: snapshot.propertyId,
      period,
      suggestionCount: suggestions.length,
      hasTiedSuggestions: hasTie,
      tenantOpenBalanceCents: null,
      hasProbableDuplicate: duplicate,
      currencyMismatch: false,
      providerReversed: false,
      unknownReversalTarget: false,
      correlationId,
      actorSystem: 'ingestion-worker',
    });
  }

  /**
   * Looks for another payment on the same account with the same amount, date
   * and reference.
   *
   * Different external ids, so record-level deduplication would not catch it:
   * this is the case where a tenant, or a bank, genuinely sent the same payment
   * twice, and only a person can decide which one is real.
   */
  private async findProbableDuplicate(
    tx: PrismaTransaction,
    row: {
      id: string;
      bankAccountId: string;
      amountCents: bigint;
      postedDate: Date;
      reference: string | null;
    },
  ): Promise<boolean> {
    const count = await tx.bankTransaction.count({
      where: {
        id: { not: row.id },
        bankAccountId: row.bankAccountId,
        amountCents: row.amountCents,
        postedDate: row.postedDate,
        reference: row.reference,
        status: { not: 'REVERSED' },
      },
    });
    return count > 0;
  }
}

/**
 * Posts the receipt entry.
 *
 * Extracted so the logic is identical whichever ingestion path calls it, and so
 * the post-once guarantee has exactly one call site to reason about.
 */
async function ensureReceiptPosted(
  tx: PrismaTransaction,
  params: {
    accountIds: ReadonlyMap<LedgerAccountCode, string>;
    transactionId: string;
    organizationId: string;
    propertyId: string;
    amountCents: number;
    currency: string;
    postingDate: LocalDate;
    valueDate: LocalDate;
    description: string;
    correlationId: string | null;
  },
): Promise<void> {
  await writeJournalEntry(
    tx,
    buildPaymentReceivedEntry({
      transactionId: params.transactionId,
      organizationId: params.organizationId,
      propertyId: params.propertyId,
      amount: money(params.amountCents, params.currency),
      postingDate: params.postingDate,
      valueDate: params.valueDate,
      description: params.description,
    }),
    params.accountIds,
    { createdByUserId: null, correlationId: params.correlationId },
  );
}
