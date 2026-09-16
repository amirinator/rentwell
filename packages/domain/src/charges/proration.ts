/**
 * Charge proration.
 *
 * The configured policy is ACTUAL_DAYS_IN_MONTH: a partial month bills
 *
 *     monthly amount x occupied calendar days / days in that calendar month
 *
 * Occupied days are counted inclusively, so a lease running 2026-03-01 through
 * 2026-03-15 occupies 15 of March's 31 days. The multiplication and division
 * happen in exact decimal arithmetic and the result is rounded to cents exactly
 * once, at the end, so a full month never drifts from the scheduled amount.
 */

import { Decimal, dec } from '../money/decimal';
import { fromDecimal, toDecimal, type Money } from '../money/money';
import {
  daysInMonth,
  intersectRanges,
  parsePeriodKey,
  periodRange,
  rangeLengthDays,
  type DateRange,
  type PeriodKey,
} from '../periods/dates';
import { ProrationMethod } from '../types';
import { DomainError } from '../errors';

/** Everything needed to reproduce a prorated figure from stored data. */
export interface ProrationDetail {
  readonly method: ProrationMethod;
  /** True when the service range covers the whole calendar month. */
  readonly isFullPeriod: boolean;
  readonly occupiedDays: number;
  readonly daysInPeriod: number;
  /** Scheduled full-month amount, in cents. */
  readonly scheduledAmountCents: number;
  /** Exact unrounded result as a decimal string, before rounding to cents. */
  readonly unroundedAmount: string;
  /** Fraction applied, as a decimal string. "1" for a full period. */
  readonly factor: string;
  readonly roundingMode: 'HALF_UP';
}

export interface ProrationResult {
  readonly amount: Money;
  readonly detail: ProrationDetail;
}

export interface ProrationInput {
  /** The full-month scheduled amount. */
  readonly scheduledAmount: Money;
  /** The accounting period being generated. */
  readonly period: PeriodKey;
  /** The service range actually covered, already clipped to the period. */
  readonly serviceRange: DateRange;
  readonly method?: ProrationMethod;
}

/**
 * Computes the amount due for a service range inside one accounting period.
 *
 * `serviceRange` must lie inside the period; the caller clips it, because the
 * clipping decision (lease term, schedule effective dates) belongs to charge
 * generation rather than to arithmetic.
 */
export function prorateMonthlyAmount(input: ProrationInput): ProrationResult {
  const method = input.method ?? ProrationMethod.ACTUAL_DAYS_IN_MONTH;
  const period = periodRange(input.period);
  const { year, month } = parsePeriodKey(input.period);
  const daysInPeriod = daysInMonth(year, month);

  const clipped = intersectRanges(period, input.serviceRange);
  if (clipped === null) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Service range ${input.serviceRange.start}..${input.serviceRange.end} lies outside period ${input.period}`,
      { details: { period: input.period, serviceRange: input.serviceRange } },
    );
  }
  if (clipped.start !== input.serviceRange.start || clipped.end !== input.serviceRange.end) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Service range must be clipped to the accounting period before proration',
      { details: { period: input.period, serviceRange: input.serviceRange } },
    );
  }

  const occupiedDays = rangeLengthDays(clipped);
  const isFullPeriod = occupiedDays === daysInPeriod;

  if (isFullPeriod || method === ProrationMethod.NONE) {
    return {
      amount: input.scheduledAmount,
      detail: {
        method,
        isFullPeriod,
        occupiedDays,
        daysInPeriod,
        scheduledAmountCents: input.scheduledAmount.cents,
        unroundedAmount: toDecimal(input.scheduledAmount).toString(),
        factor: '1',
        roundingMode: 'HALF_UP',
      },
    };
  }

  const denominator = method === ProrationMethod.THIRTY_DAY_MONTH ? 30 : daysInPeriod;
  const numerator = dec(occupiedDays);
  const divisor = dec(denominator);

  // Multiply first, divide second: keeps the exact product and defers the only
  // inexact step to a single high-precision division.
  const product = toDecimal(input.scheduledAmount).times(numerator);
  const unrounded = product.dividedBy(divisor);
  const factor = numerator.dividedBy(divisor);

  return {
    amount: fromDecimal(unrounded, input.scheduledAmount.currency, 'HALF_UP'),
    detail: {
      method,
      isFullPeriod: false,
      occupiedDays,
      daysInPeriod,
      scheduledAmountCents: input.scheduledAmount.cents,
      unroundedAmount: unrounded.toString(),
      factor: factor.toString(),
      roundingMode: 'HALF_UP',
    },
  };
}

/**
 * Recomputes a stored charge from its recorded proration detail.
 *
 * Used by the subledger consistency check and by the audit explorer to show
 * that a posted amount still follows from the inputs it recorded.
 */
export function recomputeFromDetail(detail: ProrationDetail, currency: string): Money {
  if (detail.isFullPeriod || detail.method === ProrationMethod.NONE) {
    return { cents: detail.scheduledAmountCents, currency };
  }
  const denominator = detail.method === ProrationMethod.THIRTY_DAY_MONTH ? 30 : detail.daysInPeriod;
  const product = Decimal.ofUnits(BigInt(detail.scheduledAmountCents), 2).times(
    dec(detail.occupiedDays),
  );
  return fromDecimal(product.dividedBy(dec(denominator)), currency, 'HALF_UP');
}
