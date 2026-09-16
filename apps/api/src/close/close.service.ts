/**
 * Month-end close.
 *
 * The close decision is evaluated twice from one definition:
 *
 *  - when the controller opens the workspace, to show what still needs doing;
 *  - inside the closing transaction, holding the period lock, to decide.
 *
 * Both call `gatherFacts` and then the domain's `evaluateCloseReadiness`. A
 * blocker resolved between the two evaluations is picked up; a blocker created
 * between them stops the close. That is the whole point of re-checking under
 * the lock, and it is why a posting cannot race past a close: whichever
 * transaction takes the period lock first finishes, and the other sees its
 * committed result.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  DomainError,
  OutboxEventType,
  PeriodStatus,
  assertCloseAllowed,
  assertPeriodTransition,
  buildCloseSnapshot,
  comparePeriods,
  evaluateCloseReadiness,
  periodEnd,
  previousPeriod,
  type CloseAcknowledgementCode,
  type CloseFacts,
  type CloseReadiness,
  type PeriodKey,
} from '@rentwell/domain';
import {
  centsFromDb,
  centsToDb,
  claimIdempotencyKey,
  completeIdempotencyKey,
  enqueueOutboxEvent,
  loadCumulativeBalances,
  localDateToDb,
  lockPeriod,
  pendingOutboxCount,
  recordAuditEvent,
  toJson,
  type PrismaTransaction,
} from '@rentwell/database';
import { getMetrics, type Logger } from '@rentwell/observability';
import { PrismaService } from '../prisma/prisma.service';
import { CLOCK, LOGGER } from '../common/tokens';
import type { Clock } from '../common/clock';
import { authorizeProperty } from '../common/guards';
import type { GqlContext } from '../common/context';
import { ExceptionsService } from '../reconciliation/exceptions.service';

@Injectable()
export class CloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exceptions: ExceptionsService,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------
  // Readiness
  // ------------------------------------------------------------------------

  async readiness(ctx: GqlContext, propertyId: string, period: PeriodKey): Promise<CloseReadiness> {
    const property = await this.loadProperty(propertyId);
    authorizeProperty(ctx, 'close_snapshot:read', property);
    const facts = await this.gatherFacts(this.prisma.client, property, period);
    return evaluateCloseReadiness(facts, this.clock.now());
  }

  /**
   * Collects everything the checklist needs.
   *
   * Two receivables figures are computed independently — one from charge rows,
   * one from journal lines — and the checklist blocks the close if they
   * disagree. That comparison is the system's own proof that the subledger and
   * the operational records tell the same story.
   */
  private async gatherFacts(
    db: PrismaTransaction,
    property: { id: string; organizationId: string; currency: string },
    period: PeriodKey,
  ): Promise<CloseFacts> {
    const currency = property.currency.trim();
    const previous = previousPeriod(period);

    const [
      periodRow,
      priorRow,
      leasesMissingCharges,
      activeImportCount,
      unreviewedTransactionCount,
      exceptionCounts,
      chargeTotals,
      transactionTotals,
      balances,
      outboxPending,
      earliestPeriodRow,
    ] = await Promise.all([
      db.accountingPeriod.findUnique({
        where: { propertyId_period: { propertyId: property.id, period } },
        select: { status: true },
      }),
      db.accountingPeriod.findUnique({
        where: { propertyId_period: { propertyId: property.id, period: previous } },
        select: { status: true },
      }),
      this.countLeasesMissingCharges(db, property.id, period),
      db.importBatch.count({
        where: {
          propertyId: property.id,
          status: {
            in: [
              'DRAFT',
              'VALIDATING',
              'READY',
              'QUEUED',
              'PROCESSING',
              'VALIDATION_FAILED',
              'FAILED',
            ],
          },
        },
      }),
      db.bankTransaction.count({
        where: {
          propertyId: property.id,
          period,
          status: { in: ['UNAPPLIED', 'PARTIALLY_ALLOCATED'] },
          exceptions: { none: { status: { not: 'RESOLVED' } } },
        },
      }),
      this.exceptions.blockingCount(db, property.id, period),
      db.charge.aggregate({
        where: { propertyId: property.id, period },
        _sum: { amountCents: true, allocatedCents: true, creditedCents: true },
      }),
      db.bankTransaction.aggregate({
        where: { propertyId: property.id, period, status: { not: 'REVERSED' } },
        _sum: { amountCents: true, allocatedCents: true },
      }),
      loadCumulativeBalances(db, property.id, period),
      pendingOutboxCount(db, property.organizationId),
      db.accountingPeriod.findFirst({
        where: { propertyId: property.id },
        orderBy: { period: 'asc' },
        select: { period: true },
      }),
    ]);

    // Cumulative receivables from the subledger, in its normal (debit) direction.
    let receivableDebits = 0;
    let receivableCredits = 0;
    let unappliedDebits = 0;
    let unappliedCredits = 0;
    let netDebitMinusCredit = 0;

    for (const row of balances) {
      const debit = centsFromDb(row.debitCents);
      const credit = centsFromDb(row.creditCents);
      netDebitMinusCredit += debit - credit;

      if (row.accountCode === 'ACCOUNTS_RECEIVABLE') {
        receivableDebits += debit;
        receivableCredits += credit;
      }
      if (row.accountCode === 'UNAPPLIED_CASH') {
        unappliedDebits += debit;
        unappliedCredits += credit;
      }
    }

    const subledgerReceivables = receivableDebits - receivableCredits;
    // Unapplied cash is credit-normal, so a positive balance is credits less debits.
    const unappliedCash = unappliedCredits - unappliedDebits;

    const chargeDerivedReceivables = await this.chargeDerivedReceivables(db, property.id, period);

    const unclassifiedUnapplied = await this.unclassifiedUnappliedCash(db, property.id, period);

    // A period with no predecessor row is the first one for this property.
    const hasPredecessor =
      earliestPeriodRow !== null && comparePeriods(earliestPeriodRow.period, period) < 0;

    return {
      propertyId: property.id,
      period,
      currency,
      periodStatus: (periodRow?.status ?? PeriodStatus.OPEN) as CloseFacts['periodStatus'],
      priorPeriodStatus: hasPredecessor
        ? ((priorRow?.status ?? PeriodStatus.OPEN) as CloseFacts['priorPeriodStatus'])
        : null,
      leasesMissingCharges,
      activeImportCount,
      // Version 1 has no separate posting-job queue that the API can inspect:
      // every posting happens inside the request or inside an outbox consumer,
      // so undispatched outbox events are the complete in-flight signal and
      // this stays zero. Documented in docs/financial-model.md.
      activePostingJobCount: 0,
      pendingOutboxCount: outboxPending,
      unreviewedTransactionCount,
      blockingExceptionCount: exceptionCounts.blocking,
      nonBlockingExceptionCount: exceptionCounts.nonBlocking,
      // Version 1 approves allocations directly rather than routing them to a
      // second approver, so there is no pending-approval queue. The blocker
      // stays in the domain model for the maker/checker flow a later version
      // would add; here it is always satisfied.
      pendingApprovalCount: 0,
      netDebitMinusCreditCents: netDebitMinusCredit,
      subledgerReceivablesCents: subledgerReceivables,
      chargeDerivedReceivablesCents: chargeDerivedReceivables,
      unappliedCashCents: unappliedCash,
      unclassifiedUnappliedCashCents: unclassifiedUnapplied,
      chargesPostedCents: centsFromDb(chargeTotals._sum.amountCents),
      paymentsReceivedCents: centsFromDb(transactionTotals._sum.amountCents),
      paymentsAllocatedCents: centsFromDb(transactionTotals._sum.allocatedCents),
    };
  }

  /**
   * Cumulative receivables derived from charge rows, through the given period.
   *
   * Deliberately computed from a different source than the subledger figure it
   * is compared against; computing both the same way would prove nothing.
   */
  private async chargeDerivedReceivables(
    db: PrismaTransaction,
    propertyId: string,
    throughPeriod: PeriodKey,
  ): Promise<number> {
    const rows = await db.$queryRaw<{ outstanding: bigint | null }[]>`
      SELECT COALESCE(
               SUM("amountCents" - "allocatedCents" - "creditedCents"), 0
             )::bigint AS "outstanding"
      FROM "charges"
      WHERE "propertyId" = ${propertyId}::uuid
        AND "period" <= ${throughPeriod}
    `;
    return centsFromDb(rows[0]?.outstanding ?? 0n);
  }

  /**
   * Unapplied cash with no recorded classification.
   *
   * "Classified" means a controller resolved an exception for that payment with
   * an explicit CLASSIFIED_UNAPPLIED decision. Anything else is unexplained.
   */
  private async unclassifiedUnappliedCash(
    db: PrismaTransaction,
    propertyId: string,
    throughPeriod: PeriodKey,
  ): Promise<number> {
    const rows = await db.$queryRaw<{ unclassified: bigint | null }[]>`
      SELECT COALESCE(SUM(t."amountCents" - t."allocatedCents"), 0)::bigint AS "unclassified"
      FROM "bank_transactions" t
      WHERE t."propertyId" = ${propertyId}::uuid
        AND t."period" <= ${throughPeriod}
        AND t."status" IN ('UNAPPLIED', 'PARTIALLY_ALLOCATED')
        AND NOT EXISTS (
          SELECT 1 FROM "reconciliation_exceptions" e
          WHERE e."transactionId" = t."id"
            AND e."status" = 'RESOLVED'
            AND e."resolution" = 'CLASSIFIED_UNAPPLIED'
        )
    `;
    return centsFromDb(rows[0]?.unclassified ?? 0n);
  }

  /**
   * Active leases in the period with no generated charge at all.
   *
   * Counts leases rather than schedules: a lease with some of its schedules
   * generated is a partial run the accountant can see in the preview, whereas a
   * lease with nothing is the case that silently under-bills a tenant.
   */
  private async countLeasesMissingCharges(
    db: PrismaTransaction,
    propertyId: string,
    period: PeriodKey,
  ): Promise<number> {
    const periodStartDate = localDateToDb(`${period}-01`);
    const periodEndDate = localDateToDb(periodEnd(period));

    const rows = await db.$queryRaw<{ missing: bigint }[]>`
      SELECT COUNT(*)::bigint AS "missing"
      FROM "leases" l
      WHERE l."propertyId" = ${propertyId}::uuid
        AND l."status" = 'ACTIVE'
        AND l."termStart" <= ${periodEndDate}
        AND (l."termEnd" IS NULL OR l."termEnd" >= ${periodStartDate})
        AND EXISTS (
          SELECT 1 FROM "charge_schedules" s
          WHERE s."leaseId" = l."id" AND s."isActive" = true
        )
        AND NOT EXISTS (
          SELECT 1 FROM "charges" c
          WHERE c."leaseId" = l."id" AND c."period" = ${period}
        )
    `;
    return Number(rows[0]?.missing ?? 0n);
  }

  // ------------------------------------------------------------------------
  // Transitions
  // ------------------------------------------------------------------------

  async startReview(ctx: GqlContext, propertyId: string, period: PeriodKey): Promise<string> {
    const property = await this.loadProperty(propertyId);
    const access = authorizeProperty(ctx, 'period:start_review', property);

    return this.prisma.run(async (tx) => {
      const locked = await lockPeriod(tx, access.organizationId, property.id, period);
      assertPeriodTransition(locked.status, PeriodStatus.IN_REVIEW, access.role);

      const updated = await tx.accountingPeriod.updateMany({
        where: { id: locked.id, version: locked.version },
        data: {
          status: PeriodStatus.IN_REVIEW,
          reviewStartedAt: this.clock.now(),
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new DomainError('STALE_RECORD', 'The period changed while starting the review');
      }

      await recordAuditEvent(tx, {
        organizationId: access.organizationId,
        propertyId: property.id,
        actorUserId: access.userId,
        actorSystem: null,
        action: AuditAction.PERIOD_REVIEW_STARTED,
        entityType: 'AccountingPeriod',
        entityId: locked.id,
        metadata: { period },
        correlationId: ctx.correlationId,
        occurredAt: this.clock.now(),
      });

      return locked.id;
    });
  }

  async close(
    ctx: GqlContext,
    input: {
      propertyId: string;
      period: PeriodKey;
      acknowledgements: { code: string; reason?: string | null }[];
      expectedVersion: number;
      idempotencyKey: string;
    },
  ): Promise<{ snapshotId: string }> {
    const property = await this.loadProperty(input.propertyId);
    const access = authorizeProperty(ctx, 'period:close', property);

    try {
      return await this.prisma.run(async (tx) => {
        const claim = await claimIdempotencyKey<{ snapshotId: string }>(tx, {
          organizationId: access.organizationId,
          operation: 'closePeriod',
          key: input.idempotencyKey,
          input: {
            propertyId: input.propertyId,
            period: input.period,
            acknowledgements: [...input.acknowledgements]
              .map((item) => `${item.code}:${item.reason ?? ''}`)
              .sort(),
          },
          now: this.clock.now(),
        });
        if (claim.kind === 'REPLAY') return claim.response;
        if (claim.kind === 'IN_FLIGHT') {
          throw new DomainError('CONFLICT', 'This period is already being closed', {
            retryable: true,
          });
        }

        // The lock is taken before the facts are gathered, so nothing can post
        // into the period between the evaluation and the close.
        const locked = await lockPeriod(tx, access.organizationId, property.id, input.period);

        if (locked.version !== input.expectedVersion) {
          throw new DomainError(
            'STALE_RECORD',
            'This period changed since the checklist was loaded. Reload the close workspace.',
            {
              details: {
                period: input.period,
                expectedVersion: input.expectedVersion,
                actualVersion: locked.version,
              },
            },
          );
        }

        assertPeriodTransition(locked.status, PeriodStatus.CLOSED, access.role);

        const facts = await this.gatherFacts(tx, property, input.period);
        const readiness = evaluateCloseReadiness(facts, this.clock.now());

        const attempt = {
          readiness,
          acknowledged: input.acknowledgements.map((item) => ({
            code: item.code as CloseAcknowledgementCode,
            reason: item.reason ?? null,
          })),
          actorRole: access.role,
        };

        assertCloseAllowed(attempt);

        const snapshotDraft = buildCloseSnapshot(attempt, access.userId, this.clock.now());

        const snapshot = await tx.closeSnapshot.create({
          data: {
            organizationId: access.organizationId,
            propertyId: property.id,
            periodId: locked.id,
            period: input.period,
            chargesPostedCents: centsToDb(readiness.totals.chargesPosted.cents),
            paymentsReceivedCents: centsToDb(readiness.totals.paymentsReceived.cents),
            paymentsAllocatedCents: centsToDb(readiness.totals.paymentsAllocated.cents),
            outstandingCents: centsToDb(readiness.totals.outstandingReceivables.cents),
            unappliedCashCents: centsToDb(readiness.totals.unappliedCash.cents),
            currency: facts.currency,
            checklist: toJson(snapshotDraft.checklist),
            readiness: toJson(readiness),
            closedByUserId: access.userId,
            closedAt: this.clock.now(),
          },
          select: { id: true },
        });

        const updated = await tx.accountingPeriod.updateMany({
          where: { id: locked.id, version: locked.version },
          data: {
            status: PeriodStatus.CLOSED,
            closedAt: this.clock.now(),
            version: { increment: 1 },
          },
        });
        if (updated.count === 0) {
          throw new DomainError('STALE_RECORD', 'The period changed while closing');
        }

        await recordAuditEvent(tx, {
          organizationId: access.organizationId,
          propertyId: property.id,
          actorUserId: access.userId,
          actorSystem: null,
          action: AuditAction.PERIOD_CLOSED,
          entityType: 'AccountingPeriod',
          entityId: locked.id,
          metadata: {
            period: input.period,
            snapshotId: snapshot.id,
            totals: {
              chargesPostedCents: readiness.totals.chargesPosted.cents,
              paymentsReceivedCents: readiness.totals.paymentsReceived.cents,
              outstandingCents: readiness.totals.outstandingReceivables.cents,
              unappliedCashCents: readiness.totals.unappliedCash.cents,
            },
            acknowledged: input.acknowledgements.map((item) => item.code),
          },
          correlationId: ctx.correlationId,
          occurredAt: this.clock.now(),
        });

        await enqueueOutboxEvent(tx, {
          organizationId: access.organizationId,
          eventType: OutboxEventType.PERIOD_CLOSED,
          partitionKey: `${property.id}:${input.period}`,
          payload: { propertyId: property.id, period: input.period, snapshotId: snapshot.id },
          correlationId: ctx.correlationId,
        });

        const result = { snapshotId: snapshot.id };
        await completeIdempotencyKey(tx, claim.recordId, result, this.clock.now());

        this.logger.info(
          { propertyId: property.id, period: input.period, correlationId: ctx.correlationId },
          'Closed accounting period',
        );

        return result;
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CLOSE_BLOCKED') {
        getMetrics().closeFailures.add(1, { period: input.period });
      }
      throw error;
    }
  }

  /**
   * Reopens a closed period.
   *
   * Previous snapshots are kept: reopening adds history rather than erasing it,
   * so a later close produces a second snapshot and both remain readable.
   */
  async reopen(
    ctx: GqlContext,
    input: { propertyId: string; period: PeriodKey; reason: string; expectedVersion: number },
  ): Promise<string> {
    if (input.reason.trim().length < 4) {
      throw new DomainError('VALIDATION_FAILED', 'Reopening a period requires a stated reason');
    }

    const property = await this.loadProperty(input.propertyId);
    const access = authorizeProperty(ctx, 'period:reopen', property);

    return this.prisma.run(async (tx) => {
      const locked = await lockPeriod(tx, access.organizationId, property.id, input.period);

      if (locked.version !== input.expectedVersion) {
        throw new DomainError(
          'STALE_RECORD',
          'This period changed since it was loaded. Reload and retry.',
        );
      }

      assertPeriodTransition(locked.status, PeriodStatus.OPEN, access.role);

      const updated = await tx.accountingPeriod.updateMany({
        where: { id: locked.id, version: locked.version },
        data: {
          status: PeriodStatus.OPEN,
          reopenedAt: this.clock.now(),
          reopenReason: input.reason.trim(),
          reopenCount: { increment: 1 },
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new DomainError('STALE_RECORD', 'The period changed while reopening');
      }

      await recordAuditEvent(tx, {
        organizationId: access.organizationId,
        propertyId: property.id,
        actorUserId: access.userId,
        actorSystem: null,
        action: AuditAction.PERIOD_REOPENED,
        entityType: 'AccountingPeriod',
        entityId: locked.id,
        metadata: { period: input.period, reason: input.reason.trim() },
        correlationId: ctx.correlationId,
        occurredAt: this.clock.now(),
      });

      return locked.id;
    });
  }

  private async loadProperty(propertyId: string) {
    const property = await this.prisma.client.property.findUnique({
      where: { id: propertyId },
      select: { id: true, organizationId: true, currency: true },
    });
    if (!property) {
      throw new DomainError('NOT_FOUND', 'Property not found', { details: { id: propertyId } });
    }
    return property;
  }
}
