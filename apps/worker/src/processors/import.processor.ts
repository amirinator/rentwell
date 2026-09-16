/**
 * Import batch processing.
 *
 * The whole design here exists to answer one question: what happens when this
 * worker dies halfway through a 10,000-row file?
 *
 * The answer: nothing is lost and nothing is duplicated.
 *
 *  - Rows are processed in batches. Each batch commits its payments, its
 *    journal entries, its per-row records **and** the new `checkpointRow` in
 *    one transaction. A crash rolls back the batch in flight and leaves the
 *    checkpoint where the last committed batch put it.
 *  - On retry, processing resumes from `checkpointRow`. Even if a batch is
 *    replayed because the checkpoint write was in the rolled-back transaction,
 *    the per-payment unique index turns every replayed row into a recorded
 *    duplicate rather than a second payment.
 *  - The file is re-read from object storage and its hash re-checked, so a
 *    resumed run cannot process different bytes than the ones confirmed.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  DomainError,
  ImportStatus,
  isDomainError,
  type LocalDate,
} from '@rentwell/domain';
import { recordAuditEvent, toJson } from '@rentwell/database';
import { ObjectStore, parseImportCsv, sha256Hex } from '@rentwell/integrations';
import { getMetrics, type Logger } from '@rentwell/observability';
import { PrismaService } from '@rentwell/api/modules';
import { TransactionIngestService, type IngestOutcome } from '../ingest/transaction-ingest.service';
import { OBJECT_STORE, WORKER_CONFIG, WORKER_LOGGER } from '../tokens';
import type { WorkerConfig } from '../config';
import type { ImportJobData } from '../queues';

const CONSUMER = 'import-processor';

@Injectable()
export class ImportProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: TransactionIngestService,
    @Inject(OBJECT_STORE) private readonly storage: ObjectStore,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(WORKER_LOGGER) private readonly logger: Logger,
  ) {}

  async process(data: ImportJobData): Promise<void> {
    const startedAt = Date.now();
    const log = this.logger.child({
      importId: data.importId,
      correlationId: data.correlationId ?? undefined,
    });

    const batch = await this.prisma.client.importBatch.findUnique({
      where: { id: data.importId },
      include: { bankAccount: { select: { currency: true } } },
    });

    if (!batch) {
      log.warn('Import no longer exists; nothing to process');
      return;
    }

    // CANCELLED and COMPLETED are terminal. A late job for either is a no-op,
    // not an error: the queue is allowed to deliver a job more than once.
    if (batch.status === ImportStatus.COMPLETED || batch.status === ImportStatus.CANCELLED) {
      log.info({ status: batch.status }, 'Import already in a terminal state');
      return;
    }
    if (batch.status !== ImportStatus.QUEUED && batch.status !== ImportStatus.PROCESSING) {
      log.warn({ status: batch.status }, 'Import is not queued for processing');
      return;
    }

    await this.prisma.client.importBatch.update({
      where: { id: data.importId },
      data: {
        status: ImportStatus.PROCESSING,
        startedAt: batch.startedAt ?? new Date(),
        attempts: { increment: 1 },
      },
    });

    try {
      const contents = await this.storage.get(batch.storageKey);

      // The confirmation was bound to a hash. If the bytes changed, the file
      // nobody validated must not be imported.
      const currentHash = sha256Hex(contents);
      if (currentHash !== batch.fileHash) {
        throw new DomainError(
          'FILE_HASH_MISMATCH',
          'The stored file no longer matches the confirmed contents. Re-upload and validate it.',
          { details: { importId: data.importId } },
        );
      }

      const parsed = parseImportCsv(contents.toString('utf8'), {
        expectedCurrency: batch.bankAccount.currency.trim(),
        maxRows: this.config.imports.maxRows,
      });

      if (!parsed.valid) {
        throw new DomainError(
          'IMPORT_VALIDATION_FAILED',
          'The confirmed file no longer validates. It may have been replaced.',
          { details: { errorCount: parsed.errors.length } },
        );
      }

      const resumeFrom = batch.checkpointRow;
      const pending = parsed.rows.filter((row) => row.rowNumber > resumeFrom);

      if (resumeFrom > 0) {
        log.info({ resumeFrom, remaining: pending.length }, 'Resuming an interrupted import');
      }

      const counters = { created: 0, duplicate: 0, failed: 0, processed: 0 };
      const batchSize = this.config.imports.batchSize;

      for (let offset = 0; offset < pending.length; offset += batchSize) {
        const slice = pending.slice(offset, offset + batchSize);
        const result = await this.processBatch(data, batch, slice);

        counters.created += result.created;
        counters.duplicate += result.duplicate;
        counters.failed += result.failed;
        counters.processed += slice.length;

        log.debug(
          { checkpoint: slice[slice.length - 1]!.rowNumber, ...counters },
          'Committed an import batch',
        );
      }

      const durationMs = Date.now() - startedAt;

      await this.prisma.client.importBatch.update({
        where: { id: data.importId },
        data: { status: ImportStatus.COMPLETED, completedAt: new Date(), errorMessage: null },
      });

      await recordAuditEvent(this.prisma.client, {
        organizationId: batch.organizationId,
        propertyId: batch.propertyId,
        actorUserId: null,
        actorSystem: CONSUMER,
        action: AuditAction.IMPORT_COMPLETED,
        entityType: 'ImportBatch',
        entityId: data.importId,
        metadata: { ...counters, durationMs, resumedFrom: resumeFrom },
        correlationId: data.correlationId,
        occurredAt: new Date(),
      });

      const metrics = getMetrics();
      metrics.importDuration.record(durationMs, { outcome: 'completed' });
      metrics.importRows.add(counters.created, { outcome: 'created' });
      metrics.importRows.add(counters.duplicate, { outcome: 'duplicate' });
      metrics.importRows.add(counters.failed, { outcome: 'failed' });

      log.info({ ...counters, durationMs }, 'Import completed');
    } catch (error) {
      await this.failBatch(data, batch.organizationId, batch.propertyId, error);
      // Rethrown so BullMQ retries with backoff. The checkpoint means the
      // retry resumes rather than starting over.
      throw error;
    }
  }

  /**
   * Processes one batch of rows in a single transaction.
   *
   * The checkpoint update is the last statement, inside the same transaction:
   * if anything in the batch fails, the checkpoint does not move, and the rows
   * are retried.
   */
  private async processBatch(
    job: ImportJobData,
    batch: { id: string; organizationId: string; propertyId: string; bankAccountId: string },
    rows: readonly {
      rowNumber: number;
      externalId: string;
      postedDate: LocalDate;
      amountCents: number;
      currency: string;
      reference: string | null;
      description: string | null;
      raw: Readonly<Record<string, string>>;
    }[],
  ): Promise<{ created: number; duplicate: number; failed: number }> {
    return this.prisma.run(
      async (tx) => {
        let created = 0;
        let duplicate = 0;
        let failed = 0;

        for (const row of rows) {
          let outcome: IngestOutcome;
          let message: string | null = null;
          let transactionId: string | null = null;

          try {
            const result = await this.ingest.ingest(tx, {
              organizationId: batch.organizationId,
              propertyId: batch.propertyId,
              bankAccountId: batch.bankAccountId,
              correlationId: job.correlationId,
              payment: {
                providerKey: 'csv',
                externalId: row.externalId,
                amountCents: row.amountCents,
                currency: row.currency,
                postedDate: row.postedDate,
                valueDate: null,
                reference: row.reference,
                description: row.description,
                source: 'CSV_IMPORT',
                raw: { ...row.raw },
                importBatchId: batch.id,
              },
            });
            outcome = result.outcome;
            message = result.message;
            transactionId = result.transactionId;
          } catch (error) {
            // A closed period, a currency problem or a malformed row fails that
            // row alone. Letting one bad row abort a 10,000-row file would be
            // worse than recording it and carrying on.
            if (!isDomainError(error)) throw error;
            outcome = 'SKIPPED';
            message = `${error.code}: ${error.message}`;
          }

          if (outcome === 'CREATED') created += 1;
          else if (outcome === 'DUPLICATE') duplicate += 1;
          else failed += 1;

          await tx.importRow.upsert({
            where: {
              importBatchId_rowNumber: { importBatchId: batch.id, rowNumber: row.rowNumber },
            },
            create: {
              importBatchId: batch.id,
              rowNumber: row.rowNumber,
              rawValues: toJson(row.raw),
              externalId: row.externalId,
              outcome,
              message,
              transactionId,
            },
            update: { outcome, message, transactionId },
          });
        }

        const lastRow = rows[rows.length - 1]!.rowNumber;
        await tx.importBatch.update({
          where: { id: batch.id },
          data: {
            checkpointRow: lastRow,
            processedRows: { increment: rows.length },
            createdRows: { increment: created },
            duplicateRows: { increment: duplicate },
            failedRows: { increment: failed },
          },
        });

        return { created, duplicate, failed };
      },
      // Generous, because a batch posts journal entries and generates
      // suggestions for every row it creates.
      { timeoutMs: 120_000, maxWaitMs: 15_000 },
    );
  }

  private async failBatch(
    job: ImportJobData,
    organizationId: string,
    propertyId: string,
    error: unknown,
  ): Promise<void> {
    const message = isDomainError(error)
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Unknown failure';

    await this.prisma.client.importBatch
      .update({
        where: { id: job.importId },
        data: { status: ImportStatus.FAILED, errorMessage: message.slice(0, 1000) },
      })
      .catch(() => undefined);

    await recordAuditEvent(this.prisma.client, {
      organizationId,
      propertyId,
      actorUserId: null,
      actorSystem: CONSUMER,
      action: AuditAction.IMPORT_FAILED,
      entityType: 'ImportBatch',
      entityId: job.importId,
      metadata: { message },
      correlationId: job.correlationId,
      occurredAt: new Date(),
    }).catch(() => undefined);

    getMetrics().importDuration.record(0, { outcome: 'failed' });
    this.logger.error({ err: error, importId: job.importId }, 'Import processing failed');
  }
}

/**
 * A note on `ProcessedEvent`, deliberately not used here.
 *
 * The obvious move for an at-least-once consumer is to claim the event id in
 * `ProcessedEvent` and skip if it is already claimed. That would be wrong for
 * this job. An import spans many transactions, so a claim taken up front
 * survives a mid-file crash — and the BullMQ retry would then find the event
 * claimed and skip, abandoning the import half-done.
 *
 * Instead this job is idempotent by construction, which is stronger:
 *
 *  - `checkpointRow` advances only with the batch that committed, so a retry
 *    resumes exactly where the last durable batch ended;
 *  - the unique index on (bankAccountId, providerKey, externalId) turns any
 *    replayed row into a recorded duplicate rather than a second payment;
 *  - the unique index on (organizationId, postingEventId) does the same for its
 *    journal entry.
 *
 * `ProcessedEvent` is used by consumers whose side effect has no such natural
 * key — see the provider event consumer.
 */
