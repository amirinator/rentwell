/**
 * Allocation approval and reversal.
 *
 * This is where a payment stops being cash and starts settling a receivable, so
 * it is the path with the most ways to be wrong. The protections, in the order
 * they apply:
 *
 *  1. **Period lock first.** Every period the work touches is locked before
 *     anything is read, in a deterministic order, so a close committing at the
 *     same moment either wins outright or is queued behind this.
 *  2. **Re-read under the lock.** Balances and versions are read again inside
 *     the transaction. What the reviewer saw is an input to the decision, never
 *     the basis for the arithmetic.
 *  3. **Version compare-and-swap.** Charge and transaction rows are updated with
 *     `WHERE version = expected`. Two concurrent approvals cannot both succeed:
 *     the loser's update matches zero rows and it raises a conflict.
 *  4. **Domain re-validation.** `planAllocation` runs on the freshly read rows,
 *     so limits are enforced against committed state, not a stale snapshot.
 *  5. **One transaction.** Allocations, running totals, journal entries, audit
 *     events and outbox events commit together or not at all.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  DomainError,
  OutboxEventType,
  buildAllocationReversedEntry,
  buildPaymentAllocatedEntry,
  money,
  nextChargeStatus,
  nextTransactionStatus,
  periodOf,
  planAllocation,
  planReversal,
  type AccessContext,
  type AllocationLine,
  type LocalDate,
  type PeriodKey,
} from '@rentwell/domain';
import {
  centsFromDb,
  centsToDb,
  claimIdempotencyKey,
  completeIdempotencyKey,
  enqueueOutboxEvent,
  ensureLedgerAccounts,
  localDateToDb,
  lockPeriodsInOrder,
  recordAuditEvent,
  requireLocalDateFromDb,
  toChargeSnapshot,
  toTransactionSnapshot,
  writeJournalEntry,
  type ChargeRow,
  type PrismaTransaction,
  type TransactionRow,
} from '@rentwell/database';
import { getMetrics, type Logger } from '@rentwell/observability';
import { PrismaService } from '../prisma/prisma.service';
import { CLOCK, LOGGER } from '../common/tokens';
import type { Clock } from '../common/clock';
import { authorizeProperty } from '../common/guards';
import type { GqlContext } from '../common/context';
import { ExceptionsService } from './exceptions.service';

export interface ApproveInput {
  readonly transactionId: string;
  readonly suggestionId?: string | null;
  readonly lines?:
    readonly { chargeId: string; amount: { cents: number; currency: string } }[] | null;
  readonly expectedTransactionVersion: number;
  readonly expectedChargeVersions: readonly { chargeId: string; version: number }[];
  readonly note?: string | null;
  readonly idempotencyKey: string;
}

export interface ApproveResult {
  readonly transactionId: string;
  readonly allocationIds: string[];
  readonly totalAllocatedCents: number;
  readonly remainingUnappliedCents: number;
  readonly currency: string;
  readonly exceptionId: string | null;
}

export interface ReverseResult {
  readonly allocationId: string;
  readonly transactionId: string;
  readonly chargeId: string;
  readonly reversedCents: number;
  readonly currency: string;
}

@Injectable()
export class AllocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exceptions: ExceptionsService,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------
  // Approve
  // ------------------------------------------------------------------------

  async approve(ctx: GqlContext, input: ApproveInput): Promise<ApproveResult> {
    const transaction = await this.prisma.client.bankTransaction.findUnique({
      where: { id: input.transactionId },
      include: { property: { select: { id: true, organizationId: true } } },
    });
    if (!transaction) {
      throw new DomainError('NOT_FOUND', 'Payment not found', {
        details: { id: input.transactionId },
      });
    }

    const access = authorizeProperty(ctx, 'allocation:approve', transaction.property);
    const metrics = getMetrics();

    try {
      return await this.prisma.run(async (tx) => {
        const claim = await claimIdempotencyKey<ApproveResult>(tx, {
          organizationId: access.organizationId,
          operation: 'approveAllocations',
          key: input.idempotencyKey,
          input: {
            transactionId: input.transactionId,
            suggestionId: input.suggestionId ?? null,
            lines: (input.lines ?? []).map((line) => ({
              chargeId: line.chargeId,
              cents: line.amount.cents,
            })),
            expectedTransactionVersion: input.expectedTransactionVersion,
          },
          now: this.clock.now(),
        });
        if (claim.kind === 'REPLAY') return claim.response;
        if (claim.kind === 'IN_FLIGHT') {
          throw new DomainError('CONFLICT', 'The same approval is already being processed', {
            retryable: true,
          });
        }

        const lines = await this.resolveLines(tx, input, access);
        const chargeIds = [...new Set(lines.map((line) => line.chargeId))];

        // Read the charges once to learn their periods, then lock every period
        // involved — the payment's and each charge's — in a fixed order.
        const chargePeriods = await tx.charge.findMany({
          where: { id: { in: chargeIds }, organizationId: access.organizationId },
          select: { id: true, propertyId: true, period: true },
        });
        if (chargePeriods.length !== chargeIds.length) {
          throw new DomainError('NOT_FOUND', 'One of the charges no longer exists');
        }

        const postingDate = this.postingDateFor(transaction.postedDate);
        const postingPeriod = periodOf(postingDate);

        await lockPeriodsInOrder(tx, access.organizationId, [
          { propertyId: transaction.propertyId, period: postingPeriod },
          ...chargePeriods.map((row) => ({ propertyId: row.propertyId, period: row.period })),
        ]);

        await this.assertPeriodsAcceptPostings(tx, transaction.propertyId, [
          postingPeriod,
          ...chargePeriods.map((row) => row.period),
        ]);

        // Re-read everything under the lock. This is the state the decision is
        // actually made against.
        const freshTransaction = await tx.bankTransaction.findUniqueOrThrow({
          where: { id: transaction.id },
        });
        const freshCharges = await tx.charge.findMany({
          where: { id: { in: chargeIds }, organizationId: access.organizationId },
          include: { lease: { select: { paymentReference: true } } },
        });

        this.assertVersionsUnchanged(input, freshTransaction, freshCharges);

        const transactionSnapshot = toTransactionSnapshot(
          freshTransaction as unknown as TransactionRow,
        );
        const chargeSnapshots = freshCharges.map((row) =>
          toChargeSnapshot(row as unknown as ChargeRow),
        );

        const plan = planAllocation({
          transaction: transactionSnapshot,
          charges: chargeSnapshots,
          lines,
        });

        const accountIds = await ensureLedgerAccounts(tx, access.organizationId);
        const allocationIds: string[] = [];
        const chargeById = new Map(chargeSnapshots.map((charge) => [charge.id, charge]));

        // Fold duplicate lines so one charge receives exactly one allocation row.
        const byCharge = new Map<string, number>();
        for (const line of plan.lines) {
          byCharge.set(line.chargeId, (byCharge.get(line.chargeId) ?? 0) + line.amount.cents);
        }

        for (const [chargeId, cents] of [...byCharge.entries()].sort(([a], [b]) =>
          a < b ? -1 : 1,
        )) {
          const charge = chargeById.get(chargeId)!;

          const allocation = await tx.allocation.create({
            data: {
              organizationId: access.organizationId,
              propertyId: transaction.propertyId,
              transactionId: transaction.id,
              chargeId,
              amountCents: centsToDb(cents),
              currency: transactionSnapshot.currency,
              status: 'ACTIVE',
              postingDate: localDateToDb(postingDate),
              period: postingPeriod,
              suggestionId: input.suggestionId ?? null,
              approvedByUserId: access.userId,
              approvedAt: this.clock.now(),
              note: input.note?.slice(0, 500) ?? null,
            },
            select: { id: true },
          });
          allocationIds.push(allocation.id);

          const allocatedAfter = money(
            charge.allocatedAmount.cents + cents,
            transactionSnapshot.currency,
          );

          // Compare-and-swap on the charge. A concurrent approver who read the
          // same version loses here and is told to reload.
          const updated = await tx.charge.updateMany({
            where: { id: chargeId, version: charge.version },
            data: {
              allocatedCents: centsToDb(allocatedAfter.cents),
              openCents: centsToDb(
                charge.amount.cents - allocatedAfter.cents - charge.creditedAmount.cents,
              ),
              status: nextChargeStatus(charge, allocatedAfter, charge.creditedAmount),
              version: { increment: 1 },
            },
          });
          if (updated.count === 0) {
            throw new DomainError(
              'STALE_RECORD',
              'This charge was modified while the approval was in progress. Reload and review the current balance.',
              { details: { chargeId, expectedVersion: charge.version } },
            );
          }

          await writeJournalEntry(
            tx,
            buildPaymentAllocatedEntry({
              allocationId: allocation.id,
              transactionId: transaction.id,
              chargeId,
              organizationId: access.organizationId,
              propertyId: transaction.propertyId,
              tenantId: charge.tenantId,
              leaseId: charge.leaseId,
              amount: money(cents, transactionSnapshot.currency),
              postingDate,
              description: `Payment allocated to ${charge.id}`,
            }),
            accountIds,
            { createdByUserId: access.userId, correlationId: ctx.correlationId },
          );
        }

        const transactionAllocatedAfter = money(
          transactionSnapshot.allocatedAmount.cents + plan.totalAllocated.cents,
          transactionSnapshot.currency,
        );

        const transactionUpdated = await tx.bankTransaction.updateMany({
          where: { id: transaction.id, version: transactionSnapshot.version },
          data: {
            allocatedCents: centsToDb(transactionAllocatedAfter.cents),
            status: nextTransactionStatus(transactionSnapshot, transactionAllocatedAfter),
            version: { increment: 1 },
          },
        });
        if (transactionUpdated.count === 0) {
          throw new DomainError(
            'STALE_RECORD',
            'This payment was modified while the approval was in progress. Reload and try again.',
            { details: { transactionId: transaction.id } },
          );
        }

        if (input.suggestionId) {
          await tx.matchSuggestion.updateMany({
            where: { id: input.suggestionId, transactionId: transaction.id },
            data: { status: 'APPROVED' },
          });
          // Competing proposals for the same payment are no longer actionable.
          await tx.matchSuggestion.updateMany({
            where: {
              transactionId: transaction.id,
              status: 'PROPOSED',
              id: { not: input.suggestionId },
            },
            data: { status: 'SUPERSEDED', supersededAt: this.clock.now() },
          });
        }

        const exceptionId = await this.exceptions.reconcileAfterAllocation(tx, {
          access,
          transactionId: transaction.id,
          propertyId: transaction.propertyId,
          remainingUnappliedCents: plan.remainingUnapplied.cents,
          currency: transactionSnapshot.currency,
          period: postingPeriod,
          correlationId: ctx.correlationId,
          allocationsCreated: allocationIds.length,
        });

        await recordAuditEvent(tx, {
          organizationId: access.organizationId,
          propertyId: transaction.propertyId,
          actorUserId: access.userId,
          actorSystem: null,
          action: AuditAction.ALLOCATIONS_APPROVED,
          entityType: 'BankTransaction',
          entityId: transaction.id,
          metadata: {
            allocationIds,
            totalAllocatedCents: plan.totalAllocated.cents,
            remainingUnappliedCents: plan.remainingUnapplied.cents,
            suggestionId: input.suggestionId ?? null,
            period: postingPeriod,
          },
          correlationId: ctx.correlationId,
          occurredAt: this.clock.now(),
        });

        await enqueueOutboxEvent(tx, {
          organizationId: access.organizationId,
          eventType: OutboxEventType.ALLOCATION_APPROVED,
          partitionKey: transaction.id,
          payload: { transactionId: transaction.id, allocationIds },
          correlationId: ctx.correlationId,
        });

        const result: ApproveResult = {
          transactionId: transaction.id,
          allocationIds,
          totalAllocatedCents: plan.totalAllocated.cents,
          remainingUnappliedCents: plan.remainingUnapplied.cents,
          currency: transactionSnapshot.currency,
          exceptionId,
        };

        await completeIdempotencyKey(tx, claim.recordId, result, this.clock.now());

        this.logger.info(
          {
            transactionId: transaction.id,
            allocations: allocationIds.length,
            correlationId: ctx.correlationId,
          },
          'Approved allocations',
        );

        return result;
      });
    } catch (error) {
      if (
        error instanceof DomainError &&
        [
          'STALE_RECORD',
          'CONFLICT',
          'INSUFFICIENT_CHARGE_BALANCE',
          'INSUFFICIENT_PAYMENT_BALANCE',
          'PERIOD_CLOSED',
        ].includes(error.code)
      ) {
        metrics.allocationConflicts.add(1, { code: error.code });
      }
      throw error;
    }
  }

  /**
   * Turns the request into concrete lines.
   *
   * A suggestion is read from the database rather than trusted from the client:
   * the client says *which* suggestion, never what it contains.
   */
  private async resolveLines(
    tx: PrismaTransaction,
    input: ApproveInput,
    access: AccessContext,
  ): Promise<AllocationLine[]> {
    if (input.suggestionId) {
      const suggestion = await tx.matchSuggestion.findFirst({
        where: {
          id: input.suggestionId,
          transactionId: input.transactionId,
          organizationId: access.organizationId,
        },
        select: { status: true, lines: true },
      });
      if (!suggestion) {
        throw new DomainError('NOT_FOUND', 'Suggestion not found for this payment');
      }
      if (suggestion.status !== 'PROPOSED') {
        throw new DomainError(
          'CONFLICT',
          `This suggestion is ${suggestion.status} and can no longer be approved`,
          { details: { suggestionId: input.suggestionId, status: suggestion.status } },
        );
      }

      const stored = suggestion.lines as unknown;
      if (!Array.isArray(stored) || stored.length === 0) {
        throw new DomainError('CONFLICT', 'The stored suggestion has no allocation lines');
      }

      return stored.map((entry) => {
        const line = entry as { chargeId?: unknown; amountCents?: unknown; currency?: unknown };
        if (typeof line.chargeId !== 'string' || typeof line.amountCents !== 'number') {
          throw new DomainError('CONFLICT', 'The stored suggestion is malformed');
        }
        return {
          chargeId: line.chargeId,
          amount: money(line.amountCents, String(line.currency ?? 'USD')),
        };
      });
    }

    if (!input.lines || input.lines.length === 0) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Supply either a suggestionId or at least one allocation line',
      );
    }

    return input.lines.map((line) => ({
      chargeId: line.chargeId,
      amount: money(line.amount.cents, line.amount.currency),
    }));
  }

  /**
   * Confirms the reviewer's view is still current.
   *
   * Checked before `planAllocation` so the reviewer gets "reload and look
   * again" rather than a balance error about numbers they never saw.
   */
  private assertVersionsUnchanged(
    input: ApproveInput,
    transaction: { id: string; version: number },
    charges: readonly { id: string; version: number }[],
  ): void {
    if (transaction.version !== input.expectedTransactionVersion) {
      throw new DomainError(
        'STALE_RECORD',
        'This payment changed since you opened it. Reload to see the current allocations.',
        {
          details: {
            transactionId: transaction.id,
            expectedVersion: input.expectedTransactionVersion,
            actualVersion: transaction.version,
          },
        },
      );
    }

    const expected = new Map(
      input.expectedChargeVersions.map((item) => [item.chargeId, item.version]),
    );
    for (const charge of charges) {
      const expectedVersion = expected.get(charge.id);
      if (expectedVersion === undefined) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'Every charge in an approval must carry the version the reviewer saw',
          { details: { chargeId: charge.id } },
        );
      }
      if (expectedVersion !== charge.version) {
        throw new DomainError(
          'STALE_RECORD',
          'A charge changed since you opened this payment. Reload to see the current balance.',
          {
            details: {
              chargeId: charge.id,
              expectedVersion,
              actualVersion: charge.version,
            },
          },
        );
      }
    }
  }

  private async assertPeriodsAcceptPostings(
    tx: PrismaTransaction,
    propertyId: string,
    periods: readonly PeriodKey[],
  ): Promise<void> {
    const unique = [...new Set(periods)];
    const rows = await tx.accountingPeriod.findMany({
      where: { propertyId, period: { in: unique } },
      select: { period: true, status: true },
    });

    for (const row of rows) {
      if (row.status === 'CLOSED') {
        getMetrics().closedPeriodRejections.add(1, { period: row.period });
        throw new DomainError(
          'PERIOD_CLOSED',
          `Accounting period ${row.period} is closed for this property and rejects financial changes.`,
          { details: { propertyId, period: row.period } },
        );
      }
    }
  }

  /**
   * Allocations post on the payment's own posted date.
   *
   * Using today would put a March payment reconciled in April into the April
   * period, breaking the tie between cash and the receivable it settles.
   */
  private postingDateFor(postedDate: Date): LocalDate {
    return requireLocalDateFromDb(postedDate);
  }

  // ------------------------------------------------------------------------
  // Reverse
  // ------------------------------------------------------------------------

  /**
   * Reverses one allocation with a compensating record and entry.
   *
   * Nothing is deleted or edited: the original allocation is marked REVERSED,
   * an `AllocationReversal` records who did it and why, and an opposite journal
   * entry links back to the original posting event.
   */
  async reverse(
    ctx: GqlContext,
    input: {
      allocationId: string;
      reason: string;
      postingDate?: LocalDate | null;
      idempotencyKey: string;
    },
  ): Promise<ReverseResult> {
    if (input.reason.trim().length < 4) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Reversing an allocation requires a stated reason',
      );
    }

    const allocation = await this.prisma.client.allocation.findUnique({
      where: { id: input.allocationId },
      include: { property: { select: { id: true, organizationId: true } } },
    });
    if (!allocation) {
      throw new DomainError('NOT_FOUND', 'Allocation not found', {
        details: { id: input.allocationId },
      });
    }

    const access = authorizeProperty(ctx, 'allocation:reverse', allocation.property);

    return this.prisma.run(async (tx) => {
      const claim = await claimIdempotencyKey<ReverseResult>(tx, {
        organizationId: access.organizationId,
        operation: 'reverseAllocation',
        key: input.idempotencyKey,
        input: { allocationId: input.allocationId, reason: input.reason },
        now: this.clock.now(),
      });
      if (claim.kind === 'REPLAY') return claim.response;
      if (claim.kind === 'IN_FLIGHT') {
        throw new DomainError('CONFLICT', 'The same reversal is already being processed', {
          retryable: true,
        });
      }

      const current = await tx.allocation.findUniqueOrThrow({
        where: { id: allocation.id },
        select: {
          id: true,
          status: true,
          amountCents: true,
          currency: true,
          chargeId: true,
          transactionId: true,
          propertyId: true,
          period: true,
        },
      });

      const postingDate = input.postingDate ?? this.reversalPostingDate(current.period);
      const postingPeriod = periodOf(postingDate);

      const charge = await tx.charge.findUniqueOrThrow({
        where: { id: current.chargeId },
        select: { period: true, propertyId: true },
      });

      await lockPeriodsInOrder(tx, access.organizationId, [
        { propertyId: current.propertyId, period: postingPeriod },
        { propertyId: current.propertyId, period: current.period },
        { propertyId: charge.propertyId, period: charge.period },
      ]);

      await this.assertPeriodsAcceptPostings(tx, current.propertyId, [
        postingPeriod,
        current.period,
        charge.period,
      ]);

      const freshTransaction = await tx.bankTransaction.findUniqueOrThrow({
        where: { id: current.transactionId },
      });
      const freshCharge = await tx.charge.findUniqueOrThrow({
        where: { id: current.chargeId },
        include: { lease: { select: { paymentReference: true } } },
      });

      const transactionSnapshot = toTransactionSnapshot(
        freshTransaction as unknown as TransactionRow,
      );
      const chargeSnapshot = toChargeSnapshot(freshCharge as unknown as ChargeRow);

      const plan = planReversal({
        allocationId: current.id,
        allocationStatus: current.status,
        allocatedAmount: money(centsFromDb(current.amountCents), current.currency.trim()),
        transaction: transactionSnapshot,
        charge: chargeSnapshot,
      });

      // The unique index on allocationId is the real guard against a double
      // reversal; this CAS makes the losing request fail cleanly.
      const marked = await tx.allocation.updateMany({
        where: { id: current.id, status: 'ACTIVE' },
        data: { status: 'REVERSED' },
      });
      if (marked.count === 0) {
        throw new DomainError(
          'ALLOCATION_ALREADY_REVERSED',
          'This allocation has already been reversed',
          {
            details: { allocationId: current.id },
          },
        );
      }

      const reversal = await tx.allocationReversal.create({
        data: {
          organizationId: access.organizationId,
          allocationId: current.id,
          amountCents: centsToDb(plan.reversedAmount.cents),
          reason: input.reason.trim(),
          postingDate: localDateToDb(postingDate),
          period: postingPeriod,
          reversedByUserId: access.userId,
        },
        select: { id: true },
      });

      await tx.charge.update({
        where: { id: chargeSnapshot.id },
        data: {
          allocatedCents: centsToDb(plan.chargeAllocatedAfter.cents),
          openCents: centsToDb(
            chargeSnapshot.amount.cents -
              plan.chargeAllocatedAfter.cents -
              chargeSnapshot.creditedAmount.cents,
          ),
          status: plan.chargeStatusAfter,
          version: { increment: 1 },
        },
      });

      await tx.bankTransaction.update({
        where: { id: transactionSnapshot.id },
        data: {
          allocatedCents: centsToDb(plan.transactionAllocatedAfter.cents),
          status: plan.transactionStatusAfter,
          version: { increment: 1 },
        },
      });

      const accountIds = await ensureLedgerAccounts(tx, access.organizationId);
      await writeJournalEntry(
        tx,
        buildAllocationReversedEntry({
          reversalId: reversal.id,
          allocationId: current.id,
          transactionId: current.transactionId,
          chargeId: current.chargeId,
          organizationId: access.organizationId,
          propertyId: current.propertyId,
          tenantId: chargeSnapshot.tenantId,
          leaseId: chargeSnapshot.leaseId,
          amount: plan.reversedAmount,
          postingDate,
          reason: input.reason.trim(),
        }),
        accountIds,
        { createdByUserId: access.userId, correlationId: ctx.correlationId },
      );

      await recordAuditEvent(tx, {
        organizationId: access.organizationId,
        propertyId: current.propertyId,
        actorUserId: access.userId,
        actorSystem: null,
        action: AuditAction.ALLOCATION_REVERSED,
        entityType: 'Allocation',
        entityId: current.id,
        metadata: {
          reversalId: reversal.id,
          amountCents: plan.reversedAmount.cents,
          reason: input.reason.trim(),
          chargeId: current.chargeId,
          transactionId: current.transactionId,
          period: postingPeriod,
        },
        correlationId: ctx.correlationId,
        occurredAt: this.clock.now(),
      });

      await enqueueOutboxEvent(tx, {
        organizationId: access.organizationId,
        eventType: OutboxEventType.ALLOCATION_REVERSED,
        partitionKey: current.transactionId,
        payload: { allocationId: current.id, transactionId: current.transactionId },
        correlationId: ctx.correlationId,
      });

      const result: ReverseResult = {
        allocationId: current.id,
        transactionId: current.transactionId,
        chargeId: current.chargeId,
        reversedCents: plan.reversedAmount.cents,
        currency: current.currency.trim(),
      };

      await completeIdempotencyKey(tx, claim.recordId, result, this.clock.now());
      return result;
    });
  }

  /**
   * A reversal posts into the period the allocation belongs to, dated today
   * when today falls in that period and on its first day otherwise. Keeping the
   * reversal with the entry it unwinds is what makes the two cancel inside one
   * period rather than moving a balance between months.
   *
   * If that period is already closed, the period lock rejects the reversal and
   * the controller chooses between reopening the period and recording a
   * correction in the current one. The caller can force the latter by passing
   * an explicit `postingDate`.
   */
  private reversalPostingDate(allocationPeriod: PeriodKey): LocalDate {
    const today = this.clock.now().toISOString().slice(0, 10) as LocalDate;
    return periodOf(today) === allocationPeriod ? today : `${allocationPeriod}-01`;
  }
}
