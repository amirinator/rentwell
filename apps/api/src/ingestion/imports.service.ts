/**
 * Payment import lifecycle.
 *
 *   DRAFT -> VALIDATING -> READY -> QUEUED -> PROCESSING -> COMPLETED
 *                       \-> VALIDATION_FAILED        \-> FAILED
 *            (any pre-QUEUED state) -> CANCELLED
 *
 * Three decisions shape this service:
 *
 *  1. **Validation is complete before anything is written.** The whole file is
 *     parsed and every error collected, so an accountant fixes one file rather
 *     than discovering problems one row at a time.
 *  2. **Confirmation is bound to the bytes that were validated.** The caller
 *     must quote the SHA-256 hash returned by validation. Replacing the object
 *     in storage after validating invalidates the confirmation instead of
 *     importing something nobody checked.
 *  3. **Row processing happens in the worker, in resumable batches.** The API
 *     only moves the batch to QUEUED and publishes an outbox event, so a large
 *     file never holds an HTTP request open.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  DomainError,
  ImportStatus,
  OutboxEventType,
  type AccessContext,
  type ImportStatus as ImportStatusValue,
} from '@rentwell/domain';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  enqueueOutboxEvent,
  recordAuditEvent,
  toJson,
} from '@rentwell/database';
import {
  ObjectStore,
  importObjectKey,
  parseImportCsv,
  sha256Hex,
  type ImportError,
} from '@rentwell/integrations';
import type { Logger } from '@rentwell/observability';
import { PrismaService } from '../prisma/prisma.service';
import { CLOCK, LOGGER, OBJECT_STORE } from '../common/tokens';
import type { Clock } from '../common/clock';
import { API_CONFIG, type ApiConfig } from '../config/configuration';
import { authorizeProperty } from '../common/guards';
import type { GqlContext } from '../common/context';

/** States a batch may be cancelled from. Once queued, the worker owns it. */
const CANCELLABLE: readonly ImportStatusValue[] = [
  ImportStatus.DRAFT,
  ImportStatus.VALIDATING,
  ImportStatus.READY,
  ImportStatus.VALIDATION_FAILED,
];

/** States a failed batch may be retried from. */
const RETRYABLE: readonly ImportStatusValue[] = [ImportStatus.FAILED];

export interface UploadTicket {
  readonly importId: string;
  readonly uploadUrl: string;
  readonly storageKey: string;
  readonly expiresAt: string;
}

export interface ValidationSummary {
  readonly importId: string;
  readonly status: ImportStatusValue;
  readonly totalRows: number;
  readonly validRows: number;
  readonly errors: readonly ImportError[];
  readonly fileHash: string;
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORE) private readonly storage: ObjectStore,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------
  // Create and upload
  // ------------------------------------------------------------------------

  async createUpload(
    ctx: GqlContext,
    input: { propertyId: string; bankAccountId: string; filename: string; fileSizeBytes: number },
  ): Promise<UploadTicket> {
    if (input.fileSizeBytes <= 0 || input.fileSizeBytes > this.config.imports.maxFileBytes) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `File size must be between 1 byte and ${this.config.imports.maxFileBytes} bytes`,
        { details: { fileSizeBytes: input.fileSizeBytes } },
      );
    }
    if (!/\.csv$/i.test(input.filename)) {
      throw new DomainError('VALIDATION_FAILED', 'Only .csv files are accepted');
    }

    const bankAccount = await this.prisma.client.bankAccount.findUnique({
      where: { id: input.bankAccountId },
      include: { property: { select: { id: true, organizationId: true } } },
    });
    if (!bankAccount || bankAccount.propertyId !== input.propertyId) {
      throw new DomainError('NOT_FOUND', 'Bank account not found for that property');
    }

    const access = authorizeProperty(ctx, 'import:create', bankAccount.property);
    if (!bankAccount.isActive) {
      throw new DomainError('VALIDATION_FAILED', 'That bank account is inactive');
    }

    const batch = await this.prisma.client.importBatch.create({
      data: {
        organizationId: access.organizationId,
        propertyId: input.propertyId,
        bankAccountId: input.bankAccountId,
        status: ImportStatus.DRAFT,
        originalFilename: input.filename.slice(0, 200),
        // Placeholder until the object exists; replaced when validation reads it.
        storageKey: '',
        fileSizeBytes: input.fileSizeBytes,
        fileHash: '',
        uploadedByUserId: access.userId,
      },
      select: { id: true },
    });

    const storageKey = importObjectKey(access.organizationId, batch.id, input.filename);
    await this.prisma.client.importBatch.update({
      where: { id: batch.id },
      data: { storageKey },
    });

    const uploadUrl = await this.storage.signedUploadUrl(storageKey);

    await recordAuditEvent(this.prisma.client, {
      organizationId: access.organizationId,
      propertyId: input.propertyId,
      actorUserId: access.userId,
      actorSystem: null,
      action: AuditAction.IMPORT_CREATED,
      entityType: 'ImportBatch',
      entityId: batch.id,
      metadata: { filename: input.filename, bankAccountId: input.bankAccountId },
      correlationId: ctx.correlationId,
      occurredAt: this.clock.now(),
    });

    return {
      importId: batch.id,
      uploadUrl,
      storageKey,
      expiresAt: new Date(
        this.clock.now().getTime() + this.config.storage.signedUrlTtlSeconds * 1000,
      ).toISOString(),
    };
  }

  // ------------------------------------------------------------------------
  // Validate
  // ------------------------------------------------------------------------

  async validate(ctx: GqlContext, importId: string): Promise<ValidationSummary> {
    const batch = await this.loadBatch(importId);
    const access = authorizeProperty(ctx, 'import:create', batch.property);

    if (
      batch.status !== ImportStatus.DRAFT &&
      batch.status !== ImportStatus.VALIDATION_FAILED &&
      batch.status !== ImportStatus.READY
    ) {
      throw new DomainError(
        'IMPORT_STATE_INVALID',
        `An import in ${batch.status} cannot be validated`,
        { details: { importId, status: batch.status } },
      );
    }

    await this.prisma.client.importBatch.update({
      where: { id: importId },
      data: { status: ImportStatus.VALIDATING },
    });

    let contents: Buffer;
    try {
      contents = await this.storage.get(batch.storageKey);
    } catch (error) {
      await this.prisma.client.importBatch.update({
        where: { id: importId },
        data: {
          status: ImportStatus.VALIDATION_FAILED,
          errorMessage: 'The uploaded file could not be read. Upload it again.',
        },
      });
      this.logger.warn({ err: error, importId }, 'Import file could not be read from storage');
      throw new DomainError('IMPORT_VALIDATION_FAILED', 'The uploaded file could not be read');
    }

    const fileHash = sha256Hex(contents);

    const parsed = parseImportCsv(contents.toString('utf8'), {
      expectedCurrency: batch.bankAccount.currency.trim(),
      maxRows: this.config.imports.maxRows,
    });

    const status = parsed.valid ? ImportStatus.READY : ImportStatus.VALIDATION_FAILED;

    // The file has already been read from storage, so nothing external happens
    // inside this transaction: the outcome and the record of it commit together.
    await this.prisma.run(async (tx) => {
      await tx.importBatch.update({
        where: { id: importId },
        data: {
          status,
          totalRows: parsed.totalDataRows,
          fileHash,
          fileSizeBytes: contents.byteLength,
          validationErrors: toJson(parsed.errors),
          errorMessage: parsed.valid ? null : `${parsed.errors.length} validation error(s)`,
          validatedAt: this.clock.now(),
        },
      });

      await recordAuditEvent(tx, {
        organizationId: access.organizationId,
        propertyId: batch.propertyId,
        actorUserId: access.userId,
        actorSystem: null,
        action: AuditAction.IMPORT_VALIDATED,
        entityType: 'ImportBatch',
        entityId: importId,
        metadata: {
          status,
          totalRows: parsed.totalDataRows,
          validRows: parsed.rows.length,
          errorCount: parsed.errors.length,
          fileHash,
        },
        correlationId: ctx.correlationId,
        occurredAt: this.clock.now(),
      });
    });

    return {
      importId,
      status,
      totalRows: parsed.totalDataRows,
      validRows: parsed.rows.length,
      errors: parsed.errors,
      fileHash,
    };
  }

  // ------------------------------------------------------------------------
  // Confirm
  // ------------------------------------------------------------------------

  /**
   * Queues a validated import for processing.
   *
   * The supplied hash must match the stored one, and the stored one must still
   * match the object in storage. Both checks matter: the first proves the
   * accountant confirmed the file they were shown, the second proves nobody
   * replaced the object between validation and confirmation.
   */
  async confirm(
    ctx: GqlContext,
    input: { importId: string; fileHash: string; idempotencyKey: string },
  ): Promise<string> {
    const batch = await this.loadBatch(input.importId);
    const access = authorizeProperty(ctx, 'import:confirm', batch.property);

    if (batch.status !== ImportStatus.READY) {
      throw new DomainError(
        'IMPORT_STATE_INVALID',
        `Only a validated import can be confirmed. This one is ${batch.status}.`,
        { details: { importId: input.importId, status: batch.status } },
      );
    }

    if (batch.fileHash !== input.fileHash) {
      throw new DomainError(
        'FILE_HASH_MISMATCH',
        'The file changed since it was validated. Validate it again before confirming.',
        { details: { importId: input.importId } },
      );
    }

    const contents = await this.storage.get(batch.storageKey);
    const currentHash = sha256Hex(contents);
    if (currentHash !== batch.fileHash) {
      await this.prisma.client.importBatch.update({
        where: { id: input.importId },
        data: {
          status: ImportStatus.VALIDATION_FAILED,
          errorMessage: 'The stored file no longer matches the validated contents.',
        },
      });
      throw new DomainError(
        'FILE_HASH_MISMATCH',
        'The stored file no longer matches what was validated. Upload and validate again.',
        { details: { importId: input.importId } },
      );
    }

    // File-level duplicate check. It supplements per-row deduplication rather
    // than replacing it: the same file uploaded twice is almost always a
    // mistake, while the same payment arriving in two different files is not.
    const duplicateFile = await this.prisma.client.importBatch.findFirst({
      where: {
        bankAccountId: batch.bankAccountId,
        fileHash: batch.fileHash,
        status: ImportStatus.COMPLETED,
        id: { not: batch.id },
      },
      select: { id: true, completedAt: true },
    });
    if (duplicateFile) {
      throw new DomainError(
        'CONFLICT',
        'An identical file was already imported into this bank account. Cancel this import, or change the file if the payments really are new.',
        {
          details: {
            previousImportId: duplicateFile.id,
            previousCompletedAt: duplicateFile.completedAt?.toISOString() ?? null,
          },
        },
      );
    }

    return this.prisma.run(async (tx) => {
      const claim = await claimIdempotencyKey<string>(tx, {
        organizationId: access.organizationId,
        operation: 'confirmImport',
        key: input.idempotencyKey,
        input: { importId: input.importId, fileHash: input.fileHash },
        now: this.clock.now(),
      });
      if (claim.kind === 'REPLAY') return claim.response;
      if (claim.kind === 'IN_FLIGHT') {
        throw new DomainError('CONFLICT', 'This import is already being confirmed', {
          retryable: true,
        });
      }

      const moved = await tx.importBatch.updateMany({
        where: { id: input.importId, status: ImportStatus.READY },
        data: {
          status: ImportStatus.QUEUED,
          confirmedAt: this.clock.now(),
          confirmedByUserId: access.userId,
          checkpointRow: 0,
          processedRows: 0,
          createdRows: 0,
          duplicateRows: 0,
          failedRows: 0,
          errorMessage: null,
        },
      });
      if (moved.count === 0) {
        throw new DomainError('IMPORT_STATE_INVALID', 'This import is no longer ready to confirm');
      }

      await enqueueOutboxEvent(tx, {
        organizationId: access.organizationId,
        eventType: OutboxEventType.IMPORT_CONFIRMED,
        partitionKey: input.importId,
        payload: {
          importId: input.importId,
          propertyId: batch.propertyId,
          bankAccountId: batch.bankAccountId,
        },
        correlationId: ctx.correlationId,
      });

      await recordAuditEvent(tx, {
        organizationId: access.organizationId,
        propertyId: batch.propertyId,
        actorUserId: access.userId,
        actorSystem: null,
        action: AuditAction.IMPORT_CONFIRMED,
        entityType: 'ImportBatch',
        entityId: input.importId,
        metadata: { fileHash: input.fileHash, totalRows: batch.totalRows },
        correlationId: ctx.correlationId,
        occurredAt: this.clock.now(),
      });

      await completeIdempotencyKey(tx, claim.recordId, input.importId, this.clock.now());
      return input.importId;
    });
  }

  // ------------------------------------------------------------------------
  // Cancel and retry
  // ------------------------------------------------------------------------

  async cancel(ctx: GqlContext, importId: string): Promise<string> {
    const batch = await this.loadBatch(importId);
    const access = authorizeProperty(ctx, 'import:cancel', batch.property);

    if (!CANCELLABLE.includes(batch.status as ImportStatusValue)) {
      throw new DomainError(
        'IMPORT_STATE_INVALID',
        `An import in ${batch.status} cannot be cancelled. Processing has already started.`,
        { details: { importId, status: batch.status } },
      );
    }

    await this.prisma.run(async (tx) => {
      const cancelled = await tx.importBatch.updateMany({
        where: { id: importId, status: { in: [...CANCELLABLE] } },
        data: { status: ImportStatus.CANCELLED, completedAt: this.clock.now() },
      });
      if (cancelled.count === 0) {
        throw new DomainError('IMPORT_STATE_INVALID', 'This import can no longer be cancelled');
      }

      await recordAuditEvent(tx, {
        organizationId: access.organizationId,
        propertyId: batch.propertyId,
        actorUserId: access.userId,
        actorSystem: null,
        action: AuditAction.IMPORT_CANCELLED,
        entityType: 'ImportBatch',
        entityId: importId,
        metadata: { previousStatus: batch.status },
        correlationId: ctx.correlationId,
        occurredAt: this.clock.now(),
      });
    });

    return importId;
  }

  /**
   * Re-queues a failed import.
   *
   * Counters are deliberately not reset: the worker resumes from
   * `checkpointRow`, and every payment it already created is protected by the
   * per-row unique index, so a retry neither duplicates a payment nor
   * re-processes work that already committed.
   */
  async retry(ctx: GqlContext, importId: string): Promise<string> {
    const batch = await this.loadBatch(importId);
    const access = authorizeProperty(ctx, 'import:confirm', batch.property);

    if (!RETRYABLE.includes(batch.status as ImportStatusValue)) {
      throw new DomainError(
        'IMPORT_STATE_INVALID',
        `Only a failed import can be retried. This one is ${batch.status}.`,
        { details: { importId, status: batch.status } },
      );
    }

    return this.prisma.run(async (tx) => {
      const moved = await tx.importBatch.updateMany({
        where: { id: importId, status: ImportStatus.FAILED },
        data: { status: ImportStatus.QUEUED, errorMessage: null },
      });
      if (moved.count === 0) {
        throw new DomainError('IMPORT_STATE_INVALID', 'This import is no longer in a failed state');
      }

      await enqueueOutboxEvent(tx, {
        organizationId: access.organizationId,
        eventType: OutboxEventType.IMPORT_CONFIRMED,
        partitionKey: importId,
        payload: {
          importId,
          propertyId: batch.propertyId,
          bankAccountId: batch.bankAccountId,
          resumedFromRow: batch.checkpointRow,
        },
        correlationId: ctx.correlationId,
      });

      return importId;
    });
  }

  // ------------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------------

  /**
   * Mints a download URL for the source file.
   *
   * Authorization happens here, before a URL exists. The URL itself grants
   * access to whoever holds it, so it is short-lived and every issuance is
   * audited.
   */
  async downloadUrl(ctx: GqlContext, importId: string): Promise<string | null> {
    const batch = await this.loadBatch(importId);
    const access = authorizeProperty(ctx, 'import:download_file', batch.property);

    if (!batch.storageKey) return null;

    const url = await this.storage.signedDownloadUrl(batch.storageKey, batch.originalFilename);

    await recordAuditEvent(this.prisma.client, {
      organizationId: access.organizationId,
      propertyId: batch.propertyId,
      actorUserId: access.userId,
      actorSystem: null,
      action: AuditAction.IMPORT_FILE_DOWNLOADED,
      entityType: 'ImportBatch',
      entityId: importId,
      metadata: { storageKey: batch.storageKey },
      correlationId: ctx.correlationId,
      occurredAt: this.clock.now(),
    });

    return url;
  }

  /** Loads a batch and its property, or reports NOT_FOUND. */
  private async loadBatch(importId: string) {
    const batch = await this.prisma.client.importBatch.findUnique({
      where: { id: importId },
      include: {
        property: { select: { id: true, organizationId: true } },
        bankAccount: { select: { id: true, currency: true } },
      },
    });
    if (!batch) {
      throw new DomainError('NOT_FOUND', 'Import not found', { details: { id: importId } });
    }
    return batch;
  }

  /** Active import count for a property, used by the dashboard and close checklist. */
  async activeCount(access: AccessContext, propertyIds: string[] | null): Promise<number> {
    return this.prisma.client.importBatch.count({
      where: {
        organizationId: access.organizationId,
        ...(propertyIds ? { propertyId: { in: propertyIds } } : {}),
        status: {
          in: [
            ImportStatus.DRAFT,
            ImportStatus.VALIDATING,
            ImportStatus.READY,
            ImportStatus.QUEUED,
            ImportStatus.PROCESSING,
          ],
        },
      },
    });
  }

  async failedCount(access: AccessContext, propertyIds: string[] | null): Promise<number> {
    return this.prisma.client.importBatch.count({
      where: {
        organizationId: access.organizationId,
        ...(propertyIds ? { propertyId: { in: propertyIds } } : {}),
        status: { in: [ImportStatus.FAILED, ImportStatus.VALIDATION_FAILED] },
      },
    });
  }
}
