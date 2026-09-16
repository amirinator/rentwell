/**
 * Bank transaction reads, and the reversal path.
 *
 * Reversal is the one write here, and it is the most delicate ingestion case:
 * a provider can reverse a payment that has already been allocated, and the
 * unwinding has to happen in the right order. Active allocations are reversed
 * first, then the receipt itself. Reversing the receipt while allocations are
 * still live would leave unapplied cash negative and receivables overstated.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  DomainError,
  ExceptionCategory,
  ExceptionSeverity,
  OutboxEventType,
  TransactionStatus,
  buildAllocationReversedEntry,
  buildPaymentReversedEntry,
  money,
  periodOf,
  type AccessContext,
  type LocalDate,
  type PeriodKey,
} from '@rentwell/domain';
import {
  centsFromDb,
  centsToDb,
  enqueueOutboxEvent,
  ensureLedgerAccounts,
  localDateToDb,
  lockPeriodsInOrder,
  recordAuditEvent,
  requireLocalDateFromDb,
  writeJournalEntry,
  type PrismaTransaction,
} from '@rentwell/database';
import type { Logger } from '@rentwell/observability';
import { PrismaService } from '../prisma/prisma.service';
import { CLOCK, LOGGER } from '../common/tokens';
import type { Clock } from '../common/clock';
import { authorize } from '../common/guards';
import type { GqlContext } from '../common/context';
import { ExceptionsService } from '../reconciliation/exceptions.service';

export interface ReversalOutcome {
  readonly transactionId: string;
  readonly reversedAllocationIds: string[];
  readonly reversedAmountCents: number;
  readonly exceptionId: string | null;
}

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exceptions: ExceptionsService,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Applies a provider-reported reversal.
   *
   * Runs inside the caller's transaction, because the worker that receives the
   * provider event must commit the reversal and its `ProcessedEvent` row
   * together — otherwise a redelivery would reverse a payment twice.
   *
   * Idempotent by construction: a transaction already marked REVERSED returns
   * its existing state rather than posting a second reversal.
   */
  async applyProviderReversal(
    tx: PrismaTransaction,
    access: AccessContext,
    params: {
      transactionId: string;
      reason: string;
      correlationId: string | null;
      actorSystem?: string;
    },
  ): Promise<ReversalOutcome> {
    const transaction = await tx.bankTransaction.findFirst({
      where: { id: params.transactionId, organizationId: access.organizationId },
    });
    if (!transaction) {
      throw new DomainError('REVERSAL_TARGET_UNKNOWN', 'The reversed payment does not exist here', {
        details: { transactionId: params.transactionId },
      });
    }

    if (transaction.status === TransactionStatus.REVERSED) {
      return {
        transactionId: transaction.id,
        reversedAllocationIds: [],
        reversedAmountCents: 0,
        exceptionId: null,
      };
    }

    const currency = transaction.currency.trim();
    const postingDate = this.reversalPostingDate(transaction.period, transaction.postedDate);
    const postingPeriod = periodOf(postingDate);

    const allocations = await tx.allocation.findMany({
      where: { transactionId: transaction.id, status: 'ACTIVE' },
      select: { id: true, chargeId: true, amountCents: true, period: true, propertyId: true },
      orderBy: { id: 'asc' },
    });

    const charges = await tx.charge.findMany({
      where: { id: { in: allocations.map((row) => row.chargeId) } },
      select: {
        id: true,
        period: true,
        propertyId: true,
        tenantId: true,
        leaseId: true,
        amountCents: true,
        allocatedCents: true,
        creditedCents: true,
      },
    });
    const chargeById = new Map(charges.map((row) => [row.id, row]));

    // Lock every period the unwinding touches, in one deterministic order.
    await lockPeriodsInOrder(tx, access.organizationId, [
      { propertyId: transaction.propertyId, period: postingPeriod },
      { propertyId: transaction.propertyId, period: transaction.period },
      ...allocations.map((row) => ({ propertyId: row.propertyId, period: row.period })),
      ...charges.map((row) => ({ propertyId: row.propertyId, period: row.period })),
    ]);

    const accountIds = await ensureLedgerAccounts(tx, access.organizationId);
    const reversedAllocationIds: string[] = [];

    // Step 1: unwind the allocations.
    for (const allocation of allocations) {
      const charge = chargeById.get(allocation.chargeId);
      if (!charge) continue;

      const marked = await tx.allocation.updateMany({
        where: { id: allocation.id, status: 'ACTIVE' },
        data: { status: 'REVERSED' },
      });
      if (marked.count === 0) continue; // Already unwound by a concurrent path.

      const amountCents = centsFromDb(allocation.amountCents);
      const reversal = await tx.allocationReversal.create({
        data: {
          organizationId: access.organizationId,
          allocationId: allocation.id,
          amountCents: centsToDb(amountCents),
          reason: params.reason,
          postingDate: localDateToDb(postingDate),
          period: postingPeriod,
          reversedByUserId: access.userId,
        },
        select: { id: true },
      });

      const chargeAllocatedAfter = centsFromDb(charge.allocatedCents) - amountCents;
      const chargeAmount = centsFromDb(charge.amountCents);
      const chargeCredited = centsFromDb(charge.creditedCents);

      const safeAllocatedAfter = Math.max(0, chargeAllocatedAfter);

      await tx.charge.update({
        where: { id: charge.id },
        data: {
          allocatedCents: centsToDb(safeAllocatedAfter),
          openCents: centsToDb(chargeAmount - safeAllocatedAfter - chargeCredited),
          status:
            chargeCredited >= chargeAmount
              ? 'VOIDED'
              : chargeAllocatedAfter + chargeCredited >= chargeAmount
                ? 'SETTLED'
                : 'POSTED',
          version: { increment: 1 },
        },
      });

      await writeJournalEntry(
        tx,
        buildAllocationReversedEntry({
          reversalId: reversal.id,
          allocationId: allocation.id,
          transactionId: transaction.id,
          chargeId: charge.id,
          organizationId: access.organizationId,
          propertyId: transaction.propertyId,
          tenantId: charge.tenantId,
          leaseId: charge.leaseId,
          amount: money(amountCents, currency),
          postingDate,
          reason: params.reason,
        }),
        accountIds,
        { createdByUserId: null, correlationId: params.correlationId },
      );

      reversedAllocationIds.push(allocation.id);
    }

    // Step 2: reverse the receipt itself, now that nothing draws on it.
    const receiptAmount = centsFromDb(transaction.amountCents);

    await tx.bankTransaction.update({
      where: { id: transaction.id },
      data: {
        status: TransactionStatus.REVERSED,
        allocatedCents: centsToDb(0),
        reversedAt: this.clock.now(),
        reversalReason: params.reason,
        version: { increment: 1 },
      },
    });

    await writeJournalEntry(
      tx,
      buildPaymentReversedEntry({
        transactionId: transaction.id,
        organizationId: access.organizationId,
        propertyId: transaction.propertyId,
        amount: money(receiptAmount, currency),
        postingDate,
        reason: params.reason,
      }),
      accountIds,
      { createdByUserId: null, correlationId: params.correlationId },
    );

    // A reversal always leaves an exception: someone has to decide what it
    // means for the tenant's balance, and it blocks the close until they do.
    const exceptionId = await this.exceptions.openOrUpdate(tx, {
      access,
      propertyId: transaction.propertyId,
      transactionId: transaction.id,
      tenantId: null,
      category: ExceptionCategory.REVERSED_PAYMENT,
      severity: ExceptionSeverity.HIGH,
      summary: `The provider reversed this payment. ${reversedAllocationIds.length} allocation(s) were unwound.`,
      openAmountCents: 0,
      currency,
      period: postingPeriod,
      correlationId: params.correlationId,
      actorSystem: params.actorSystem ?? 'provider-sync',
    });

    await recordAuditEvent(tx, {
      organizationId: access.organizationId,
      propertyId: transaction.propertyId,
      actorUserId: null,
      actorSystem: params.actorSystem ?? 'provider-sync',
      action: AuditAction.PAYMENT_REVERSED,
      entityType: 'BankTransaction',
      entityId: transaction.id,
      metadata: {
        reason: params.reason,
        reversedAllocationIds,
        reversedAmountCents: receiptAmount,
        period: postingPeriod,
      },
      correlationId: params.correlationId,
      occurredAt: this.clock.now(),
    });

    await enqueueOutboxEvent(tx, {
      organizationId: access.organizationId,
      eventType: OutboxEventType.TRANSACTION_REVERSED,
      partitionKey: transaction.id,
      payload: { transactionId: transaction.id, reversedAllocationIds },
      correlationId: params.correlationId,
    });

    this.logger.warn(
      {
        transactionId: transaction.id,
        allocations: reversedAllocationIds.length,
        correlationId: params.correlationId,
      },
      'Applied a provider payment reversal',
    );

    return {
      transactionId: transaction.id,
      reversedAllocationIds,
      reversedAmountCents: receiptAmount,
      exceptionId,
    };
  }

  /**
   * A reversal posts into the receipt's own period. If that period is closed
   * the period lock rejects it, and the integration conflict surfaces as an
   * exception for a controller to decide on rather than silently landing in a
   * different month.
   */
  private reversalPostingDate(transactionPeriod: PeriodKey, postedDate: Date): LocalDate {
    const original = requireLocalDateFromDb(postedDate);
    return periodOf(original) === transactionPeriod ? original : `${transactionPeriod}-01`;
  }

  /**
   * Requests a provider synchronisation.
   *
   * The API does not fetch from the provider itself: it publishes an outbox
   * event, which the dispatcher routes to the sync queue. That keeps a
   * potentially long, retry-prone network conversation out of an HTTP request,
   * and means a sync requested while the worker is down runs when it returns
   * rather than being lost.
   */
  async requestSync(ctx: GqlContext, connectionId: string): Promise<boolean> {
    const access = authorize(ctx, 'import:create');

    const connection = await this.prisma.client.integrationConnection.findFirst({
      where: { id: connectionId, organizationId: access.organizationId },
      select: { id: true, provider: true },
    });
    if (!connection) {
      throw new DomainError('NOT_FOUND', 'Integration connection not found', {
        details: { id: connectionId },
      });
    }

    await this.prisma.run(async (tx) => {
      await enqueueOutboxEvent(tx, {
        organizationId: access.organizationId,
        eventType: OutboxEventType.PROVIDER_SYNC_REQUESTED,
        partitionKey: connection.id,
        payload: { connectionId: connection.id },
        correlationId: ctx.correlationId,
      });

      await recordAuditEvent(tx, {
        organizationId: access.organizationId,
        propertyId: null,
        actorUserId: access.userId,
        actorSystem: null,
        action: AuditAction.PROVIDER_SYNC_REQUESTED,
        entityType: 'IntegrationConnection',
        entityId: connection.id,
        metadata: { provider: connection.provider },
        correlationId: ctx.correlationId,
        occurredAt: this.clock.now(),
      });
    });

    this.logger.info(
      { connectionId: connection.id, correlationId: ctx.correlationId },
      'Provider sync requested',
    );

    return true;
  }

  /** Transaction totals over a filter, in cents. */
  async totals(
    access: AccessContext,
    where: Record<string, unknown>,
  ): Promise<{ received: number; allocated: number; unapplied: number }> {
    const aggregate = await this.prisma.client.bankTransaction.aggregate({
      where: {
        ...where,
        organizationId: access.organizationId,
        direction: 'CREDIT',
        status: { not: TransactionStatus.REVERSED },
      },
      _sum: { amountCents: true, allocatedCents: true },
    });

    const received = centsFromDb(aggregate._sum.amountCents);
    const allocated = centsFromDb(aggregate._sum.allocatedCents);
    return { received, allocated, unapplied: received - allocated };
  }
}
