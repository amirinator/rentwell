/**
 * Charge generation and credit adjustments.
 *
 * Generation is the first place money enters the system, and it has three
 * properties worth stating explicitly:
 *
 *  1. **Preview and commit share one code path.** Both call the domain's
 *     `previewCharges`. The commit re-runs it inside the transaction, so the
 *     accountant cannot approve one set of numbers and have another posted.
 *  2. **The accountant confirms what they saw.** `expectedGenerationKeys` is
 *     compared against what the transaction would now create. If a lease was
 *     amended in between, the mutation fails with a conflict instead of posting
 *     charges nobody reviewed.
 *  3. **Repetition is free.** Every proposed charge carries a deterministic
 *     `generationKey` with a unique index behind it, so a retried request, a
 *     double-clicked button and a redelivered job all converge on one charge.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  DomainError,
  OutboxEventType,
  buildChargePostedEntry,
  buildChargeCreditedEntry,
  money,
  parsePeriodKey,
  periodEnd,
  periodOf,
  previewCharges,
  type AccessContext,
  type ChargePreview,
  type LeaseGenerationInput,
  type LocalDate,
  type PeriodKey,
  type ProposedCharge,
} from '@rentwell/domain';
import {
  centsFromDb,
  centsToDb,
  claimIdempotencyKey,
  completeIdempotencyKey,
  enqueueOutboxEvent,
  ensureLedgerAccounts,
  isUniqueViolation,
  localDateToDb,
  lockPeriodForPosting,
  recordAuditEvent,
  toJson,
  toLeaseGenerationInput,
  writeJournalEntry,
  type LeaseRow,
  type PrismaTransaction,
} from '@rentwell/database';
import type { Logger } from '@rentwell/observability';
import { PrismaService } from '../prisma/prisma.service';
import { LOGGER, CLOCK } from '../common/tokens';
import type { Clock } from '../common/clock';
import { authorizeProperty } from '../common/guards';
import type { GqlContext } from '../common/context';

export interface GenerationSummary {
  readonly period: PeriodKey;
  readonly propertyId: string;
  readonly createdCount: number;
  readonly skippedCount: number;
  readonly totalAmountCents: number;
  readonly currency: string;
  readonly warnings: ChargePreview['warnings'];
  readonly chargeIds: string[];
}

@Injectable()
export class ChargesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------
  // Preview
  // ------------------------------------------------------------------------

  async preview(ctx: GqlContext, propertyId: string, period: PeriodKey): Promise<ChargePreview> {
    const property = await this.loadProperty(propertyId);
    const access = authorizeProperty(ctx, 'charge:generate', property);

    const preview = await this.buildPreview(this.prisma.client, property, period);

    await recordAuditEvent(this.prisma.client, {
      organizationId: access.organizationId,
      propertyId,
      actorUserId: access.userId,
      actorSystem: null,
      action: AuditAction.CHARGES_PREVIEWED,
      entityType: 'Property',
      entityId: propertyId,
      metadata: {
        period,
        proposedCount: preview.proposed.length,
        skippedCount: preview.skipped.length,
        totalAmountCents: preview.totalAmount.cents,
      },
      correlationId: ctx.correlationId,
      occurredAt: this.clock.now(),
    });

    return preview;
  }

  /**
   * Builds the proposal from current data. Runs identically outside a
   * transaction (preview) and inside one (commit).
   */
  private async buildPreview(
    db: PrismaTransaction,
    property: { id: string; organizationId: string; currency: string },
    period: PeriodKey,
  ): Promise<ChargePreview> {
    parsePeriodKey(period); // Rejects a malformed period before any query.

    const periodStartDate = localDateToDb(`${period}-01`);
    const periodEndDate = localDateToDb(periodEnd(period));

    const leases = await db.lease.findMany({
      where: {
        propertyId: property.id,
        organizationId: property.organizationId,
        status: { in: ['ACTIVE', 'EXPIRED'] },
        // A lease can only be billed in a period its term overlaps.
        termStart: { lte: periodEndDate },
        OR: [{ termEnd: null }, { termEnd: { gte: periodStartDate } }],
      },
      include: {
        tenant: { select: { paymentReference: true } },
        schedules: {
          include: { versions: { orderBy: { versionNumber: 'asc' } } },
        },
      },
      orderBy: { id: 'asc' },
    });

    const existing = await db.charge.findMany({
      where: { propertyId: property.id, period },
      select: { generationKey: true },
    });

    // The `include` above selects exactly the columns `LeaseRow` declares; the
    // cast bridges Prisma's generated row type to the structural shape the
    // mapper documents, and `toLeaseGenerationInput` validates every field it
    // reads.
    const inputs: LeaseGenerationInput[] = leases.map((lease) =>
      toLeaseGenerationInput(lease as unknown as LeaseRow),
    );

    return previewCharges({
      period,
      propertyId: property.id,
      currency: property.currency.trim(),
      leases: inputs,
      existingGenerationKeys: new Set(existing.map((row) => row.generationKey)),
    });
  }

  // ------------------------------------------------------------------------
  // Generate
  // ------------------------------------------------------------------------

  async generate(
    ctx: GqlContext,
    input: {
      propertyId: string;
      period: PeriodKey;
      expectedGenerationKeys: string[];
      idempotencyKey: string;
    },
  ): Promise<GenerationSummary> {
    const property = await this.loadProperty(input.propertyId);
    const access = authorizeProperty(ctx, 'charge:generate', property);

    return this.prisma.run(async (tx) => {
      const claim = await claimIdempotencyKey<GenerationSummary>(tx, {
        organizationId: access.organizationId,
        operation: 'generateCharges',
        key: input.idempotencyKey,
        input: {
          propertyId: input.propertyId,
          period: input.period,
          keys: [...input.expectedGenerationKeys].sort(),
        },
        now: this.clock.now(),
      });

      if (claim.kind === 'REPLAY') return claim.response;
      if (claim.kind === 'IN_FLIGHT') {
        throw new DomainError('CONFLICT', 'The same generation request is already running', {
          retryable: true,
          details: { idempotencyKey: input.idempotencyKey },
        });
      }

      // Lock first, then check the period state. A close committing right now
      // will either win (and this fails) or lose (and sees OPEN).
      await lockPeriodForPosting(tx, access.organizationId, property.id, input.period);

      const preview = await this.buildPreview(tx, property, input.period);
      this.assertPreviewUnchanged(preview, input.expectedGenerationKeys);

      const accountIds = await ensureLedgerAccounts(tx, access.organizationId);
      const postingDate = this.postingDateFor(input.period);
      const chargeIds: string[] = [];
      let created = 0;

      for (const proposed of preview.proposed) {
        const chargeId = await this.insertCharge(tx, proposed, postingDate);
        if (chargeId === null) {
          // A concurrent run created it. The unique index did its job.
          continue;
        }
        chargeIds.push(chargeId);
        created += 1;

        const entry = buildChargePostedEntry({
          chargeId,
          organizationId: proposed.organizationId,
          propertyId: proposed.propertyId,
          tenantId: proposed.tenantId,
          leaseId: proposed.leaseId,
          chargeType: proposed.type,
          amount: proposed.amount,
          postingDate,
          serviceStart: proposed.serviceStart,
          description: proposed.description,
        });

        await writeJournalEntry(tx, entry, accountIds, {
          createdByUserId: access.userId,
          correlationId: ctx.correlationId,
        });
      }

      const summary: GenerationSummary = {
        period: input.period,
        propertyId: property.id,
        createdCount: created,
        skippedCount: preview.skipped.length,
        totalAmountCents: preview.totalAmount.cents,
        currency: preview.currency,
        warnings: preview.warnings,
        chargeIds,
      };

      await recordAuditEvent(tx, {
        organizationId: access.organizationId,
        propertyId: property.id,
        actorUserId: access.userId,
        actorSystem: null,
        action: AuditAction.CHARGES_GENERATED,
        entityType: 'Property',
        entityId: property.id,
        metadata: {
          period: input.period,
          createdCount: created,
          skippedCount: summary.skippedCount,
          totalAmountCents: summary.totalAmountCents,
          warnings: preview.warnings.map((warning) => warning.code),
        },
        correlationId: ctx.correlationId,
        occurredAt: this.clock.now(),
      });

      await enqueueOutboxEvent(tx, {
        organizationId: access.organizationId,
        eventType: OutboxEventType.CHARGES_GENERATED,
        partitionKey: `${property.id}:${input.period}`,
        payload: { propertyId: property.id, period: input.period, chargeIds },
        correlationId: ctx.correlationId,
      });

      await completeIdempotencyKey(tx, claim.recordId, summary, this.clock.now());

      this.logger.info(
        {
          propertyId: property.id,
          period: input.period,
          created,
          correlationId: ctx.correlationId,
        },
        'Generated charges',
      );

      return summary;
    });
  }

  /**
   * Confirms that what is about to be posted is what the accountant approved.
   *
   * Compares the exact set of generation keys, so an amendment, a new lease or
   * a terminated lease between preview and confirmation is caught rather than
   * quietly changing the outcome.
   */
  private assertPreviewUnchanged(preview: ChargePreview, expected: readonly string[]): void {
    const actual = preview.proposed.map((charge) => charge.generationKey).sort();
    const confirmed = [...expected].sort();

    const same =
      actual.length === confirmed.length && actual.every((key, index) => key === confirmed[index]);

    if (!same) {
      throw new DomainError(
        'STALE_RECORD',
        'Lease or schedule data changed since the preview. Review the new preview before generating.',
        {
          details: {
            expectedCount: confirmed.length,
            actualCount: actual.length,
            missing: confirmed.filter((key) => !actual.includes(key)),
            unexpected: actual.filter((key) => !confirmed.includes(key)),
          },
        },
      );
    }
  }

  /** Inserts one charge. Returns null when the generation key already exists. */
  private async insertCharge(
    tx: PrismaTransaction,
    proposed: ProposedCharge,
    postingDate: LocalDate,
  ): Promise<string | null> {
    try {
      const row = await tx.charge.create({
        data: {
          organizationId: proposed.organizationId,
          propertyId: proposed.propertyId,
          leaseId: proposed.leaseId,
          tenantId: proposed.tenantId,
          scheduleId: proposed.scheduleId,
          scheduleVersionId: proposed.scheduleVersionId,
          generationKey: proposed.generationKey,
          type: proposed.type,
          status: 'POSTED',
          currency: proposed.currency,
          amountCents: centsToDb(proposed.amount.cents),
          // A newly posted charge is entirely open.
          openCents: centsToDb(proposed.amount.cents),
          serviceStart: localDateToDb(proposed.serviceStart),
          serviceEnd: localDateToDb(proposed.serviceEnd),
          dueDate: localDateToDb(proposed.dueDate),
          postingDate: localDateToDb(postingDate),
          period: proposed.period,
          description: proposed.description,
          calculation: toJson({
            ...proposed.calculation,
            scheduleVersionNumber: proposed.scheduleVersionNumber,
          }),
        },
        select: { id: true },
      });
      return row.id;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /**
   * Charges are recognised on the first day of the period they bill.
   *
   * Using "today" instead would post a March charge generated on 2 April into
   * the April period, which is the opposite of what an accrual subledger means.
   */
  private postingDateFor(period: PeriodKey): LocalDate {
    return `${period}-01`;
  }

  // ------------------------------------------------------------------------
  // Credits
  // ------------------------------------------------------------------------

  /**
   * Issues a credit against a posted charge.
   *
   * A posted charge is never edited. Reducing what a tenant owes is a new,
   * separately audited record with its own reason and its own reversing journal
   * entry, so the original bill and the correction both remain visible.
   */
  async createCredit(
    ctx: GqlContext,
    input: {
      chargeId: string;
      amountCents: number;
      currency: string;
      reason: string;
      postingDate?: LocalDate | null;
      idempotencyKey: string;
    },
  ): Promise<{ chargeId: string }> {
    if (input.reason.trim().length < 4) {
      throw new DomainError('VALIDATION_FAILED', 'A credit adjustment requires a stated reason');
    }
    if (input.amountCents <= 0) {
      throw new DomainError('VALIDATION_FAILED', 'A credit amount must be greater than zero');
    }

    const charge = await this.prisma.client.charge.findUnique({
      where: { id: input.chargeId },
      include: { property: { select: { id: true, organizationId: true, currency: true } } },
    });
    if (!charge)
      throw new DomainError('NOT_FOUND', 'Charge not found', { details: { id: input.chargeId } });

    const access = authorizeProperty(ctx, 'charge:credit', charge.property);

    if (charge.currency.trim() !== input.currency.trim().toUpperCase()) {
      throw new DomainError('CURRENCY_MISMATCH', 'The credit currency does not match the charge');
    }

    const postingDate = input.postingDate ?? this.todayInPeriodOf(charge.period);
    const period = periodOf(postingDate);

    return this.prisma.run(async (tx) => {
      const claim = await claimIdempotencyKey<{ chargeId: string }>(tx, {
        organizationId: access.organizationId,
        operation: 'createCreditAdjustment',
        key: input.idempotencyKey,
        input: {
          chargeId: input.chargeId,
          amountCents: input.amountCents,
          reason: input.reason,
          postingDate,
        },
        now: this.clock.now(),
      });
      if (claim.kind === 'REPLAY') return claim.response;
      if (claim.kind === 'IN_FLIGHT') {
        throw new DomainError('CONFLICT', 'The same credit request is already running', {
          retryable: true,
        });
      }

      await lockPeriodForPosting(tx, access.organizationId, charge.propertyId, period);

      // Re-read under the lock: the open balance may have moved.
      const current = await tx.charge.findUniqueOrThrow({
        where: { id: charge.id },
        select: {
          amountCents: true,
          allocatedCents: true,
          creditedCents: true,
          currency: true,
          type: true,
          tenantId: true,
          leaseId: true,
          version: true,
        },
      });

      const amount = centsFromDb(current.amountCents);
      const allocated = centsFromDb(current.allocatedCents);
      const credited = centsFromDb(current.creditedCents);
      const creditable = amount - credited - allocated;

      if (input.amountCents > creditable) {
        throw new DomainError(
          'VALIDATION_FAILED',
          `This charge can absorb at most ${creditable} more cents of credit. Reverse an allocation first if the payment was misapplied.`,
          { details: { chargeId: charge.id, creditableCents: creditable } },
        );
      }

      const adjustment = await tx.creditAdjustment.create({
        data: {
          organizationId: access.organizationId,
          propertyId: charge.propertyId,
          chargeId: charge.id,
          amountCents: centsToDb(input.amountCents),
          currency: current.currency,
          reason: input.reason.trim(),
          postingDate: localDateToDb(postingDate),
          period,
          createdByUserId: access.userId,
        },
        select: { id: true },
      });

      const creditedAfter = credited + input.amountCents;
      const status =
        creditedAfter >= amount
          ? 'VOIDED'
          : allocated + creditedAfter >= amount
            ? 'SETTLED'
            : 'POSTED';

      await tx.charge.update({
        where: { id: charge.id },
        data: {
          creditedCents: centsToDb(creditedAfter),
          openCents: centsToDb(amount - allocated - creditedAfter),
          status,
          version: { increment: 1 },
        },
      });

      const accountIds = await ensureLedgerAccounts(tx, access.organizationId);
      await writeJournalEntry(
        tx,
        buildChargeCreditedEntry({
          creditAdjustmentId: adjustment.id,
          chargeId: charge.id,
          organizationId: access.organizationId,
          propertyId: charge.propertyId,
          tenantId: current.tenantId,
          leaseId: current.leaseId,
          chargeType: current.type,
          amount: money(input.amountCents, current.currency.trim()),
          postingDate,
          reason: input.reason.trim(),
        }),
        accountIds,
        { createdByUserId: access.userId, correlationId: ctx.correlationId },
      );

      await recordAuditEvent(tx, {
        organizationId: access.organizationId,
        propertyId: charge.propertyId,
        actorUserId: access.userId,
        actorSystem: null,
        action: AuditAction.CREDIT_ADJUSTMENT_CREATED,
        entityType: 'Charge',
        entityId: charge.id,
        metadata: {
          creditAdjustmentId: adjustment.id,
          amountCents: input.amountCents,
          reason: input.reason.trim(),
          period,
        },
        correlationId: ctx.correlationId,
        occurredAt: this.clock.now(),
      });

      const result = { chargeId: charge.id };
      await completeIdempotencyKey(tx, claim.recordId, result, this.clock.now());
      return result;
    });
  }

  /**
   * A credit posts today when today falls in the charge's own period, and on
   * the last day of that period otherwise. A late correction therefore lands in
   * the period being corrected rather than smearing into the current one — and
   * if that period is closed, the period lock rejects it and the controller
   * must choose between reopening and a current-period correction.
   */
  private todayInPeriodOf(chargePeriod: PeriodKey): LocalDate {
    const today = this.clock.now().toISOString().slice(0, 10) as LocalDate;
    return periodOf(today) === chargePeriod ? today : periodEnd(chargePeriod);
  }

  private async loadProperty(propertyId: string) {
    const property = await this.prisma.client.property.findUnique({
      where: { id: propertyId },
      select: { id: true, organizationId: true, currency: true, timezone: true },
    });
    if (!property) {
      throw new DomainError('NOT_FOUND', 'Property not found', { details: { id: propertyId } });
    }
    return property;
  }

  /**
   * Charge totals over an arbitrary filter, in cents.
   *
   * The organization id is always re-applied here rather than trusted from the
   * caller's `where`, so a filter assembled elsewhere cannot widen the scope.
   * The caller attaches the currency: every charge in a property shares one,
   * which generation and import both enforce.
   */
  async totals(
    access: AccessContext,
    where: Record<string, unknown>,
  ): Promise<{ charged: number; allocated: number; credited: number; outstanding: number }> {
    const aggregate = await this.prisma.client.charge.aggregate({
      where: { ...where, organizationId: access.organizationId },
      _sum: { amountCents: true, allocatedCents: true, creditedCents: true },
    });

    const charged = centsFromDb(aggregate._sum.amountCents);
    const allocated = centsFromDb(aggregate._sum.allocatedCents);
    const credited = centsFromDb(aggregate._sum.creditedCents);

    return { charged, allocated, credited, outstanding: charged - allocated - credited };
  }
}
