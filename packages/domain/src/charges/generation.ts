/**
 * Monthly charge generation.
 *
 * Generation is a pure function of (period, lease terms, effective-dated
 * schedule versions, already-generated keys). The same inputs always produce
 * the same proposal, which is what lets the preview shown to an accountant and
 * the committed result come from one code path.
 *
 * Idempotency comes from `generationKey`: a deterministic string identifying
 * one lease/schedule/service-segment inside one period. The database holds a
 * unique index on it, so a repeated generation run proposes nothing new and a
 * concurrent duplicate insert fails rather than double-billing a tenant.
 */

import type { CurrencyCode, Money } from '../money/money';
import { formatCents, isZero, sum, zero } from '../money/money';
import {
  addDays,
  compareLocalDate,
  daysInMonth,
  formatLocalDate,
  intersectRanges,
  isAfter,
  isOnOrAfter,
  isOnOrBefore,
  makeRange,
  parsePeriodKey,
  periodEnd,
  periodRange,
  periodStart,
  rangeContains,
  type DateRange,
  type LocalDate,
  type PeriodKey,
} from '../periods/dates';
import { prorateMonthlyAmount, type ProrationDetail } from './proration';
import {
  LeaseStatus,
  ProrationMethod,
  ScheduleFrequency,
  type ChargeType as ChargeTypeValue,
  type LeaseStatus as LeaseStatusValue,
  type ProrationMethod as ProrationMethodValue,
  type ScheduleFrequency as ScheduleFrequencyValue,
} from '../types';
import { DomainError } from '../errors';

/** Sentinel for an open-ended effective range. Sorts after every real date. */
export const OPEN_ENDED_DATE: LocalDate = '9999-12-31';

export interface ScheduleVersionInput {
  readonly scheduleId: string;
  readonly scheduleVersionId: string;
  /** Monotonic version number within the schedule. Recorded on each charge. */
  readonly versionNumber: number;
  readonly chargeType: ChargeTypeValue;
  readonly frequency: ScheduleFrequencyValue;
  /** Full-month amount for MONTHLY; total amount for ONE_TIME. */
  readonly amount: Money;
  readonly effectiveFrom: LocalDate;
  /** Inclusive last effective day, or null for open-ended. */
  readonly effectiveTo: LocalDate | null;
  /** Day of month the charge falls due. Clamped to the month's length. */
  readonly dueDayOfMonth: number;
  /** When false, a partial month still bills the full scheduled amount. */
  readonly prorate: boolean;
  readonly description: string;
}

export interface LeaseGenerationInput {
  readonly leaseId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unitId: string;
  readonly tenantId: string;
  readonly status: LeaseStatusValue;
  readonly currency: CurrencyCode;
  readonly paymentReference: string | null;
  readonly termStart: LocalDate;
  /** Inclusive last day of the term, or null for open-ended. */
  readonly termEnd: LocalDate | null;
  readonly schedules: readonly ScheduleVersionInput[];
}

export interface ProposedCharge {
  readonly generationKey: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly leaseId: string;
  readonly unitId: string;
  readonly tenantId: string;
  readonly scheduleId: string;
  readonly scheduleVersionId: string;
  readonly scheduleVersionNumber: number;
  readonly type: ChargeTypeValue;
  readonly currency: CurrencyCode;
  readonly amount: Money;
  readonly serviceStart: LocalDate;
  readonly serviceEnd: LocalDate;
  readonly dueDate: LocalDate;
  readonly period: PeriodKey;
  readonly description: string;
  readonly paymentReference: string | null;
  readonly calculation: ProrationDetail;
}

export type GenerationWarningCode =
  | 'LEASE_NOT_ACTIVE'
  | 'NO_EFFECTIVE_SCHEDULE'
  | 'ZERO_AMOUNT_SKIPPED'
  | 'PARTIAL_PERIOD'
  | 'ALREADY_GENERATED'
  | 'SCHEDULE_OVERLAP';

export interface GenerationWarning {
  readonly code: GenerationWarningCode;
  readonly message: string;
  readonly leaseId: string;
  readonly scheduleId: string | null;
}

export interface ChargePreview {
  readonly period: PeriodKey;
  readonly propertyId: string;
  readonly currency: CurrencyCode;
  readonly proposed: readonly ProposedCharge[];
  /** Generation keys already present, skipped so re-running is a no-op. */
  readonly skipped: readonly string[];
  readonly warnings: readonly GenerationWarning[];
  readonly totalAmount: Money;
  readonly leaseCount: number;
}

export interface GenerateChargesInput {
  readonly period: PeriodKey;
  readonly propertyId: string;
  readonly currency: CurrencyCode;
  readonly leases: readonly LeaseGenerationInput[];
  /** Generation keys that already exist for this property and period. */
  readonly existingGenerationKeys: ReadonlySet<string>;
  readonly prorationMethod?: ProrationMethodValue;
}

/**
 * Deterministic identity of one generated charge.
 *
 * Includes the service segment, so a mid-month rent change produces two
 * distinct charges, and excludes the amount and schedule version, so re-running
 * after an amendment does not silently create a second charge for a segment
 * that was already billed. Amending a billed segment requires an explicit
 * credit adjustment instead.
 */
export function buildGenerationKey(
  leaseId: string,
  scheduleId: string,
  period: PeriodKey,
  serviceStart: LocalDate,
  serviceEnd: LocalDate,
): string {
  return [leaseId, scheduleId, period, serviceStart, serviceEnd].join('|');
}

function effectiveRange(schedule: ScheduleVersionInput): DateRange {
  return makeRange(schedule.effectiveFrom, schedule.effectiveTo ?? OPEN_ENDED_DATE);
}

function leaseTermRange(lease: LeaseGenerationInput): DateRange {
  return makeRange(lease.termStart, lease.termEnd ?? OPEN_ENDED_DATE);
}

/** Clamps a requested day-of-month to a real date inside the period. */
function dueDateFor(period: PeriodKey, dueDayOfMonth: number): LocalDate {
  const { year, month } = parsePeriodKey(period);
  if (!Number.isInteger(dueDayOfMonth) || dueDayOfMonth < 1 || dueDayOfMonth > 31) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `dueDayOfMonth must be between 1 and 31, received ${dueDayOfMonth}`,
      { details: { dueDayOfMonth } },
    );
  }
  const day = Math.min(dueDayOfMonth, daysInMonth(year, month));
  return formatLocalDate({ year, month, day });
}

/**
 * Detects schedule versions of the same schedule whose effective ranges
 * overlap. Overlapping versions would double-bill the overlap, so generation
 * reports them as a warning and bills only the highest version number for the
 * overlapping days.
 */
function detectOverlaps(lease: LeaseGenerationInput): {
  warnings: GenerationWarning[];
  usable: ScheduleVersionInput[];
} {
  const warnings: GenerationWarning[] = [];
  const byScheduleId = new Map<string, ScheduleVersionInput[]>();
  for (const schedule of lease.schedules) {
    const bucket = byScheduleId.get(schedule.scheduleId);
    if (bucket) bucket.push(schedule);
    else byScheduleId.set(schedule.scheduleId, [schedule]);
  }

  const usable: ScheduleVersionInput[] = [];
  for (const [scheduleId, versions] of byScheduleId) {
    const ordered = [...versions].sort((a, b) => {
      const byDate = compareLocalDate(a.effectiveFrom, b.effectiveFrom);
      return byDate !== 0 ? byDate : a.versionNumber - b.versionNumber;
    });

    for (let i = 0; i < ordered.length; i += 1) {
      const current = ordered[i]!;
      const next = ordered[i + 1];
      if (next && intersectRanges(effectiveRange(current), effectiveRange(next)) !== null) {
        warnings.push({
          code: 'SCHEDULE_OVERLAP',
          message:
            `Schedule versions ${current.versionNumber} and ${next.versionNumber} overlap. ` +
            `Version ${current.versionNumber} was truncated at ${next.effectiveFrom}.`,
          leaseId: lease.leaseId,
          scheduleId,
        });
        // Truncate the earlier version the day before the later one starts.
        const truncatedEnd = addDays(next.effectiveFrom, -1);
        if (isAfter(current.effectiveFrom, truncatedEnd)) continue; // fully shadowed
        usable.push({ ...current, effectiveTo: truncatedEnd });
        continue;
      }
      usable.push(current);
    }
  }

  return { warnings, usable };
}

/** Builds the proposal for one accounting period. Never touches the database. */
export function previewCharges(input: GenerateChargesInput): ChargePreview {
  const method = input.prorationMethod ?? ProrationMethod.ACTUAL_DAYS_IN_MONTH;
  const period = periodRange(input.period);
  const proposed: ProposedCharge[] = [];
  const skipped: string[] = [];
  const warnings: GenerationWarning[] = [];
  const leaseIdsWithOutput = new Set<string>();

  for (const lease of input.leases) {
    if (lease.propertyId !== input.propertyId) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Charge generation received a lease from another property',
        {
          details: { leaseId: lease.leaseId, expected: input.propertyId, actual: lease.propertyId },
        },
      );
    }
    if (lease.currency !== input.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `Lease ${lease.leaseId} is denominated in ${lease.currency}, not ${input.currency}`,
        { details: { leaseId: lease.leaseId } },
      );
    }

    if (lease.status !== LeaseStatus.ACTIVE && lease.status !== LeaseStatus.EXPIRED) {
      warnings.push({
        code: 'LEASE_NOT_ACTIVE',
        message: `Lease is ${lease.status}; no charges were generated.`,
        leaseId: lease.leaseId,
        scheduleId: null,
      });
      continue;
    }

    const term = leaseTermRange(lease);
    const billableTerm = intersectRanges(period, term);
    if (billableTerm === null) continue;

    const { warnings: overlapWarnings, usable } = detectOverlaps(lease);
    warnings.push(...overlapWarnings);

    if (usable.length === 0) {
      warnings.push({
        code: 'NO_EFFECTIVE_SCHEDULE',
        message: 'Lease is active in this period but has no charge schedule.',
        leaseId: lease.leaseId,
        scheduleId: null,
      });
      continue;
    }

    let producedForLease = false;

    for (const schedule of usable) {
      const segment =
        schedule.frequency === ScheduleFrequency.ONE_TIME
          ? oneTimeSegment(schedule, billableTerm, input.period)
          : intersectRanges(billableTerm, effectiveRange(schedule));

      if (segment === null) continue;

      if (isZero(schedule.amount)) {
        warnings.push({
          code: 'ZERO_AMOUNT_SKIPPED',
          message: 'Schedule amount is zero; no charge was generated.',
          leaseId: lease.leaseId,
          scheduleId: schedule.scheduleId,
        });
        continue;
      }

      const generationKey = buildGenerationKey(
        lease.leaseId,
        schedule.scheduleId,
        input.period,
        segment.start,
        segment.end,
      );

      if (input.existingGenerationKeys.has(generationKey)) {
        skipped.push(generationKey);
        producedForLease = true;
        continue;
      }

      const isOneTime = schedule.frequency === ScheduleFrequency.ONE_TIME;

      // A one-time fee is never prorated: it bills its whole amount on its
      // stated date. Its calculation detail is written out here so that every
      // charge, however it was produced, carries the same shape of evidence.
      let amount: Money;
      let calculation: ProrationDetail;

      if (isOneTime) {
        const { year, month } = parsePeriodKey(input.period);
        amount = schedule.amount;
        calculation = {
          method: ProrationMethod.NONE,
          isFullPeriod: false,
          occupiedDays: 1,
          daysInPeriod: daysInMonth(year, month),
          scheduledAmountCents: schedule.amount.cents,
          unroundedAmount: formatCents(schedule.amount.cents, schedule.amount.currency),
          factor: '1',
          roundingMode: 'HALF_UP',
        };
      } else {
        const prorated = prorateMonthlyAmount({
          scheduledAmount: schedule.amount,
          period: input.period,
          serviceRange: segment,
          method: schedule.prorate ? method : ProrationMethod.NONE,
        });
        amount = prorated.amount;
        calculation = prorated.detail;
      }

      if (!isOneTime && !calculation.isFullPeriod) {
        warnings.push({
          code: 'PARTIAL_PERIOD',
          message:
            `Service period ${segment.start}..${segment.end} covers ` +
            `${calculation.occupiedDays} of ${calculation.daysInPeriod} days.`,
          leaseId: lease.leaseId,
          scheduleId: schedule.scheduleId,
        });
      }

      proposed.push({
        generationKey,
        organizationId: lease.organizationId,
        propertyId: lease.propertyId,
        leaseId: lease.leaseId,
        unitId: lease.unitId,
        tenantId: lease.tenantId,
        scheduleId: schedule.scheduleId,
        scheduleVersionId: schedule.scheduleVersionId,
        scheduleVersionNumber: schedule.versionNumber,
        type: schedule.chargeType,
        currency: lease.currency,
        amount,
        serviceStart: segment.start,
        serviceEnd: segment.end,
        dueDate: isOneTime ? segment.start : dueDateFor(input.period, schedule.dueDayOfMonth),
        period: input.period,
        description: schedule.description,
        paymentReference: lease.paymentReference,
        calculation,
      });
      producedForLease = true;
    }

    if (producedForLease) leaseIdsWithOutput.add(lease.leaseId);
  }

  // Deterministic order so the preview and the committed run agree row for row.
  proposed.sort((a, b) => {
    const byLease = a.leaseId.localeCompare(b.leaseId);
    if (byLease !== 0) return byLease;
    const bySchedule = a.scheduleId.localeCompare(b.scheduleId);
    if (bySchedule !== 0) return bySchedule;
    return compareLocalDate(a.serviceStart, b.serviceStart);
  });

  return {
    period: input.period,
    propertyId: input.propertyId,
    currency: input.currency,
    proposed,
    skipped: skipped.sort(),
    warnings,
    totalAmount:
      proposed.length === 0
        ? zero(input.currency)
        : sum(
            proposed.map((charge) => charge.amount),
            input.currency,
          ),
    leaseCount: leaseIdsWithOutput.size,
  };
}

/**
 * A one-time schedule bills on its effective-from date, once, in the period
 * that date falls in, provided the lease term covers it.
 */
function oneTimeSegment(
  schedule: ScheduleVersionInput,
  billableTerm: DateRange,
  period: PeriodKey,
): DateRange | null {
  const on = schedule.effectiveFrom;
  if (!isOnOrAfter(on, periodStart(period)) || !isOnOrBefore(on, periodEnd(period))) return null;
  if (!rangeContains(billableTerm, on)) return null;
  return makeRange(on, on);
}
