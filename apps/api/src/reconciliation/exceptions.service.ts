/**
 * Exception lifecycle.
 *
 * An exception is the record that a payment could not be reconciled cleanly.
 * The rule that shapes this whole module: **closing an exception must never be
 * a way to make a discrepancy disappear.** Resolution either names a financial
 * action that actually happened, or records an authorized classification of why
 * the difference is acceptable — and the domain checks which, against what the
 * database says was done.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  DomainError,
  ExceptionStatus,
  OutboxEventType,
  assertExceptionTransition,
  assertResolutionValid,
  classifyTransaction,
  isBlockingCategory,
  money,
  type AccessContext,
  type ExceptionCategory,
  type ExceptionResolution,
  type ExceptionSeverity,
  type PeriodKey,
  type TransactionSnapshot,
} from '@rentwell/domain';
import {
  centsFromDb,
  centsToDb,
  enqueueOutboxEvent,
  recordAuditEvent,
  type PrismaTransaction,
} from '@rentwell/database';
import type { Logger } from '@rentwell/observability';
import { PrismaService } from '../prisma/prisma.service';
import { CLOCK, LOGGER } from '../common/tokens';
import type { Clock } from '../common/clock';
import { authorize, authorizeProperty } from '../common/guards';
import type { GqlContext } from '../common/context';

export interface OpenExceptionInput {
  readonly access: AccessContext;
  readonly propertyId: string;
  readonly transactionId: string | null;
  readonly tenantId: string | null;
  readonly category: ExceptionCategory;
  readonly severity: ExceptionSeverity;
  readonly summary: string;
  readonly openAmountCents: number;
  readonly currency: string;
  readonly period: PeriodKey;
  readonly correlationId: string | null;
  readonly actorSystem?: string | null;
}

@Injectable()
export class ExceptionsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Opens an exception, or updates the open one that already covers this
   * payment.
   *
   * One payment has at most one open exception. A second unreconciled event on
   * the same payment sharpens the existing record rather than producing a
   * second row an accountant has to reconcile with the first.
   */
  async openOrUpdate(tx: PrismaTransaction, input: OpenExceptionInput): Promise<string> {
    const existing = input.transactionId
      ? await tx.reconciliationException.findFirst({
          where: {
            transactionId: input.transactionId,
            organizationId: input.access.organizationId,
            status: { not: ExceptionStatus.RESOLVED },
          },
          select: { id: true, version: true, category: true },
        })
      : null;

    const isBlocking = isBlockingCategory(input.category);

    if (existing) {
      await tx.reconciliationException.update({
        where: { id: existing.id },
        data: {
          category: input.category,
          severity: input.severity,
          summary: input.summary,
          isBlocking,
          openAmountCents: centsToDb(input.openAmountCents),
          version: { increment: 1 },
        },
      });
      return existing.id;
    }

    const created = await tx.reconciliationException.create({
      data: {
        organizationId: input.access.organizationId,
        propertyId: input.propertyId,
        transactionId: input.transactionId,
        tenantId: input.tenantId,
        category: input.category,
        status: ExceptionStatus.OPEN,
        severity: input.severity,
        summary: input.summary,
        isBlocking,
        openAmountCents: centsToDb(input.openAmountCents),
        currency: input.currency,
        period: input.period,
      },
      select: { id: true },
    });

    await recordAuditEvent(tx, {
      organizationId: input.access.organizationId,
      propertyId: input.propertyId,
      actorUserId: input.actorSystem ? null : input.access.userId,
      actorSystem: input.actorSystem ?? null,
      action: AuditAction.EXCEPTION_OPENED,
      entityType: 'ReconciliationException',
      entityId: created.id,
      metadata: {
        category: input.category,
        severity: input.severity,
        openAmountCents: input.openAmountCents,
        transactionId: input.transactionId,
      },
      correlationId: input.correlationId,
      occurredAt: this.clock.now(),
    });

    await enqueueOutboxEvent(tx, {
      organizationId: input.access.organizationId,
      eventType: OutboxEventType.EXCEPTION_OPENED,
      partitionKey: input.transactionId ?? created.id,
      payload: { exceptionId: created.id, category: input.category },
      correlationId: input.correlationId,
    });

    return created.id;
  }

  /**
   * Called from the allocation path after an approval commits.
   *
   * If the payment is now fully applied, any open exception for it is resolved
   * as ALLOCATED, with the allocation count as the evidence the domain requires.
   * If a remainder is left, the exception is opened or re-characterised as an
   * overpayment so the money is visible rather than quietly sitting unapplied.
   */
  async reconcileAfterAllocation(
    tx: PrismaTransaction,
    params: {
      access: AccessContext;
      transactionId: string;
      propertyId: string;
      remainingUnappliedCents: number;
      currency: string;
      period: PeriodKey;
      correlationId: string;
      allocationsCreated: number;
    },
  ): Promise<string | null> {
    const open = await tx.reconciliationException.findFirst({
      where: {
        transactionId: params.transactionId,
        organizationId: params.access.organizationId,
        status: { not: ExceptionStatus.RESOLVED },
      },
      select: { id: true, category: true, status: true },
    });

    if (params.remainingUnappliedCents === 0) {
      if (!open) return null;

      assertResolutionValid({
        category: open.category as ExceptionCategory,
        resolution: 'ALLOCATED',
        reason: 'Payment fully allocated to the identified charges',
        actorRole: params.access.role,
        openAmountAtOpen: money(0, params.currency),
        openAmountNow: money(0, params.currency),
        allocationsCreated: params.allocationsCreated,
        reversalsCreated: 0,
        creditsCreated: 0,
      });

      await tx.reconciliationException.update({
        where: { id: open.id },
        data: {
          status: ExceptionStatus.RESOLVED,
          resolution: 'ALLOCATED',
          resolutionReason: 'Payment fully allocated to the identified charges',
          resolvedByUserId: params.access.userId,
          resolvedAt: this.clock.now(),
          openAmountCents: centsToDb(0),
          version: { increment: 1 },
        },
      });

      await recordAuditEvent(tx, {
        organizationId: params.access.organizationId,
        propertyId: params.propertyId,
        actorUserId: params.access.userId,
        actorSystem: null,
        action: AuditAction.EXCEPTION_RESOLVED,
        entityType: 'ReconciliationException',
        entityId: open.id,
        metadata: { resolution: 'ALLOCATED', transactionId: params.transactionId },
        correlationId: params.correlationId,
        occurredAt: this.clock.now(),
      });

      return open.id;
    }

    // Money is left over. Make it visible.
    return this.openOrUpdate(tx, {
      access: params.access,
      propertyId: params.propertyId,
      transactionId: params.transactionId,
      tenantId: null,
      category: 'OVERPAYMENT',
      severity: 'LOW',
      summary: `${params.remainingUnappliedCents} cents of this payment remain unapplied after allocation.`,
      openAmountCents: params.remainingUnappliedCents,
      currency: params.currency,
      period: params.period,
      correlationId: params.correlationId,
    });
  }

  /**
   * Classifies an unreconciled payment and opens an exception if one is needed.
   * Called by the ingestion and suggestion workers, never by a user.
   */
  async classifyAndOpen(
    tx: PrismaTransaction,
    params: {
      access: AccessContext;
      transaction: TransactionSnapshot;
      propertyId: string;
      period: PeriodKey;
      suggestionCount: number;
      hasTiedSuggestions: boolean;
      tenantOpenBalanceCents: number | null;
      hasProbableDuplicate: boolean;
      currencyMismatch: boolean;
      providerReversed: boolean;
      unknownReversalTarget: boolean;
      correlationId: string | null;
      actorSystem?: string;
    },
  ): Promise<string | null> {
    const classification = classifyTransaction({
      transaction: params.transaction,
      suggestionCount: params.suggestionCount,
      hasTiedSuggestions: params.hasTiedSuggestions,
      tenantOpenBalance:
        params.tenantOpenBalanceCents === null
          ? null
          : money(params.tenantOpenBalanceCents, params.transaction.currency),
      hasProbableDuplicate: params.hasProbableDuplicate,
      currencyMismatch: params.currencyMismatch,
      providerReversed: params.providerReversed,
      unknownReversalTarget: params.unknownReversalTarget,
    });

    if (classification === null) return null;

    return this.openOrUpdate(tx, {
      access: params.access,
      propertyId: params.propertyId,
      transactionId: params.transaction.id,
      tenantId: null,
      category: classification.category,
      severity: classification.severity,
      summary: classification.summary,
      openAmountCents: params.transaction.amount.cents - params.transaction.allocatedAmount.cents,
      currency: params.transaction.currency,
      period: params.period,
      correlationId: params.correlationId,
      actorSystem: params.actorSystem ?? 'reconciliation-worker',
    });
  }

  // ------------------------------------------------------------------------
  // User-facing operations
  // ------------------------------------------------------------------------

  async assign(
    ctx: GqlContext,
    input: {
      exceptionId: string;
      assignedToUserId?: string | null;
      severity?: ExceptionSeverity | null;
      expectedVersion: number;
    },
  ): Promise<string> {
    const record = await this.loadWithProperty(input.exceptionId);
    const access = authorizeProperty(ctx, 'exception:assign', record.property);

    if (input.assignedToUserId) {
      const membership = await this.prisma.client.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: input.assignedToUserId,
            organizationId: access.organizationId,
          },
        },
        select: { status: true },
      });
      if (!membership) {
        throw new DomainError('NOT_FOUND', 'That user is not a member of this organization');
      }
    }

    const nextStatus =
      input.assignedToUserId && record.status === ExceptionStatus.OPEN
        ? ExceptionStatus.ASSIGNED
        : record.status;

    if (nextStatus !== record.status) {
      assertExceptionTransition(record.status, nextStatus, null);
    }

    // The state change and its audit entry commit together. Written as two
    // statements on the client, a crash between them would leave the exception
    // reassigned with nothing recording who did it.
    await this.prisma.run(async (tx) => {
      const updated = await tx.reconciliationException.updateMany({
        where: { id: record.id, version: input.expectedVersion },
        data: {
          assignedToUserId: input.assignedToUserId ?? null,
          ...(input.severity ? { severity: input.severity } : {}),
          status: nextStatus,
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        throw new DomainError(
          'STALE_RECORD',
          'This exception changed since you opened it. Reload and retry.',
          {
            details: { exceptionId: record.id, expectedVersion: input.expectedVersion },
          },
        );
      }

      await recordAuditEvent(tx, {
        organizationId: access.organizationId,
        propertyId: record.propertyId,
        actorUserId: access.userId,
        actorSystem: null,
        action: AuditAction.EXCEPTION_ASSIGNED,
        entityType: 'ReconciliationException',
        entityId: record.id,
        metadata: {
          assignedToUserId: input.assignedToUserId ?? null,
          severity: input.severity ?? null,
        },
        correlationId: ctx.correlationId,
        occurredAt: this.clock.now(),
      });
    });

    return record.id;
  }

  /**
   * Resolves an exception.
   *
   * The counts of allocations, reversals and credits recorded against the
   * payment *since the exception opened* are read from the database and handed
   * to the domain, which decides whether the claimed resolution is supported.
   * That is what stops "resolve as ALLOCATED" from closing a discrepancy where
   * nothing was actually allocated.
   */
  async resolve(
    ctx: GqlContext,
    input: {
      exceptionId: string;
      resolution: ExceptionResolution;
      reason: string;
      expectedVersion: number;
    },
  ): Promise<string> {
    const record = await this.loadWithProperty(input.exceptionId);
    const access = authorizeProperty(ctx, 'exception:resolve', record.property);

    if (record.status === ExceptionStatus.RESOLVED) {
      throw new DomainError('CONFLICT', 'This exception is already resolved');
    }

    const evidence = await this.gatherResolutionEvidence(record);

    assertResolutionValid({
      category: record.category as ExceptionCategory,
      resolution: input.resolution,
      reason: input.reason,
      actorRole: access.role,
      openAmountAtOpen: money(centsFromDb(record.openAmountCents), record.currency.trim()),
      openAmountNow: money(evidence.openNowCents, record.currency.trim()),
      allocationsCreated: evidence.allocationsCreated,
      reversalsCreated: evidence.reversalsCreated,
      creditsCreated: evidence.creditsCreated,
    });

    assertExceptionTransition(record.status, ExceptionStatus.RESOLVED, null);

    // Resolution records who decided and why. That evidence and the status
    // change are one fact, so they commit in one transaction rather than as two
    // statements a crash could separate.
    await this.prisma.run(async (tx) => {
      const updated = await tx.reconciliationException.updateMany({
        where: { id: record.id, version: input.expectedVersion },
        data: {
          status: ExceptionStatus.RESOLVED,
          resolution: input.resolution,
          resolutionReason: input.reason.trim(),
          resolvedByUserId: access.userId,
          resolvedAt: this.clock.now(),
          openAmountCents: centsToDb(evidence.openNowCents),
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        throw new DomainError(
          'STALE_RECORD',
          'This exception changed since you opened it. Reload and retry.',
          {
            details: { exceptionId: record.id, expectedVersion: input.expectedVersion },
          },
        );
      }

      await recordAuditEvent(tx, {
        organizationId: access.organizationId,
        propertyId: record.propertyId,
        actorUserId: access.userId,
        actorSystem: null,
        action: AuditAction.EXCEPTION_RESOLVED,
        entityType: 'ReconciliationException',
        entityId: record.id,
        metadata: {
          resolution: input.resolution,
          reason: input.reason.trim(),
          openAmountNowCents: evidence.openNowCents,
          allocationsCreated: evidence.allocationsCreated,
          reversalsCreated: evidence.reversalsCreated,
          creditsCreated: evidence.creditsCreated,
        },
        correlationId: ctx.correlationId,
        occurredAt: this.clock.now(),
      });
    });

    this.logger.info(
      { exceptionId: record.id, resolution: input.resolution, correlationId: ctx.correlationId },
      'Resolved exception',
    );

    return record.id;
  }

  async reopen(
    ctx: GqlContext,
    input: { exceptionId: string; reason: string; expectedVersion: number },
  ): Promise<string> {
    const record = await this.loadWithProperty(input.exceptionId);
    const access = authorizeProperty(ctx, 'exception:resolve', record.property);

    assertExceptionTransition(record.status, ExceptionStatus.OPEN, input.reason);

    // Reopening clears the previous resolution. The reason for doing so is the
    // only remaining record of that decision, so it commits with the change.
    await this.prisma.run(async (tx) => {
      const updated = await tx.reconciliationException.updateMany({
        where: { id: record.id, version: input.expectedVersion },
        data: {
          status: ExceptionStatus.OPEN,
          reopenedReason: input.reason.trim(),
          reopenCount: { increment: 1 },
          resolution: null,
          resolvedAt: null,
          resolvedByUserId: null,
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        throw new DomainError(
          'STALE_RECORD',
          'This exception changed since you opened it. Reload and retry.',
        );
      }

      await recordAuditEvent(tx, {
        organizationId: access.organizationId,
        propertyId: record.propertyId,
        actorUserId: access.userId,
        actorSystem: null,
        action: AuditAction.EXCEPTION_REOPENED,
        entityType: 'ReconciliationException',
        entityId: record.id,
        metadata: { reason: input.reason.trim() },
        correlationId: ctx.correlationId,
        occurredAt: this.clock.now(),
      });
    });

    return record.id;
  }

  async comment(ctx: GqlContext, exceptionId: string, body: string): Promise<string> {
    const record = await this.loadWithProperty(exceptionId);
    const access = authorizeProperty(ctx, 'exception:read', record.property);

    const trimmed = body.trim();
    if (trimmed.length === 0) {
      throw new DomainError('VALIDATION_FAILED', 'A comment cannot be empty');
    }

    await this.prisma.client.exceptionComment.create({
      data: {
        exceptionId: record.id,
        authorUserId: access.userId,
        body: trimmed.slice(0, 4000),
      },
    });

    return record.id;
  }

  /**
   * Counts the financial actions recorded against the payment since the
   * exception opened, and the amount still unreconciled.
   */
  private async gatherResolutionEvidence(record: {
    id: string;
    transactionId: string | null;
    createdAt: Date;
  }): Promise<{
    allocationsCreated: number;
    reversalsCreated: number;
    creditsCreated: number;
    openNowCents: number;
  }> {
    if (!record.transactionId) {
      return { allocationsCreated: 0, reversalsCreated: 0, creditsCreated: 0, openNowCents: 0 };
    }

    const [transaction, allocationsCreated, reversalsCreated, creditsCreated] = await Promise.all([
      this.prisma.client.bankTransaction.findUnique({
        where: { id: record.transactionId },
        select: { amountCents: true, allocatedCents: true, status: true },
      }),
      this.prisma.client.allocation.count({
        where: { transactionId: record.transactionId, approvedAt: { gte: record.createdAt } },
      }),
      this.prisma.client.allocationReversal.count({
        where: {
          allocation: { transactionId: record.transactionId },
          createdAt: { gte: record.createdAt },
        },
      }),
      this.prisma.client.creditAdjustment.count({
        where: {
          charge: { allocations: { some: { transactionId: record.transactionId } } },
          createdAt: { gte: record.createdAt },
        },
      }),
    ]);

    if (!transaction) {
      return { allocationsCreated, reversalsCreated, creditsCreated, openNowCents: 0 };
    }

    // A reversed payment has nothing outstanding to reconcile.
    const openNowCents =
      transaction.status === 'REVERSED'
        ? 0
        : centsFromDb(transaction.amountCents) - centsFromDb(transaction.allocatedCents);

    return { allocationsCreated, reversalsCreated, creditsCreated, openNowCents };
  }

  private async loadWithProperty(exceptionId: string) {
    const record = await this.prisma.client.reconciliationException.findUnique({
      where: { id: exceptionId },
      include: { property: { select: { id: true, organizationId: true } } },
    });
    if (!record) {
      throw new DomainError('NOT_FOUND', 'Exception not found', { details: { id: exceptionId } });
    }
    return record;
  }

  /** Blocking exception count for a property and period, used by the close checklist. */
  async blockingCount(
    tx: PrismaTransaction,
    propertyId: string,
    period: PeriodKey,
  ): Promise<{ blocking: number; nonBlocking: number }> {
    const [blocking, nonBlocking] = await Promise.all([
      tx.reconciliationException.count({
        where: { propertyId, period, isBlocking: true, status: { not: ExceptionStatus.RESOLVED } },
      }),
      tx.reconciliationException.count({
        where: { propertyId, period, isBlocking: false, status: { not: ExceptionStatus.RESOLVED } },
      }),
    ]);
    return { blocking, nonBlocking };
  }

  /** Read guard used by the exception list resolver. */
  requireReadAccess(ctx: GqlContext): AccessContext {
    return authorize(ctx, 'exception:read');
  }
}
