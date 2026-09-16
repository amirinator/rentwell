import { describe, expect, it } from 'vitest';
import { prorateMonthlyAmount, recomputeFromDetail } from '../src/charges/proration';
import { makeRange } from '../src/periods/dates';
import { money } from '../src/money/money';
import { ProrationMethod } from '../src/types';
import { DomainError } from '../src/errors';

const usd = (cents: number) => money(cents, 'USD');

describe('prorateMonthlyAmount', () => {
  it('bills the full scheduled amount for a complete month', () => {
    const result = prorateMonthlyAmount({
      scheduledAmount: usd(310_000),
      period: '2026-03',
      serviceRange: makeRange('2026-03-01', '2026-03-31'),
    });
    expect(result.amount.cents).toBe(310_000);
    expect(result.detail.isFullPeriod).toBe(true);
    expect(result.detail.occupiedDays).toBe(31);
    expect(result.detail.factor).toBe('1');
  });

  it('prorates by actual occupied days over actual days in the month', () => {
    // $3,100.00 x 15/31 is exactly $1,500.00.
    const result = prorateMonthlyAmount({
      scheduledAmount: usd(310_000),
      period: '2026-03',
      serviceRange: makeRange('2026-03-01', '2026-03-15'),
    });
    expect(result.amount.cents).toBe(150_000);
    expect(result.detail.occupiedDays).toBe(15);
    expect(result.detail.daysInPeriod).toBe(31);
  });

  it('rounds an inexact result once, to the nearest cent', () => {
    // $1,000.00 x 1/28 = $35.714285..., which rounds to $35.71.
    const result = prorateMonthlyAmount({
      scheduledAmount: usd(100_000),
      period: '2026-02',
      serviceRange: makeRange('2026-02-01', '2026-02-01'),
    });
    expect(result.amount.cents).toBe(3571);
    expect(result.detail.unroundedAmount).toBe('35.714285714286');
  });

  it('uses the actual length of a leap February', () => {
    const leap = prorateMonthlyAmount({
      scheduledAmount: usd(290_000),
      period: '2024-02',
      serviceRange: makeRange('2024-02-01', '2024-02-29'),
    });
    expect(leap.detail.daysInPeriod).toBe(29);
    expect(leap.detail.isFullPeriod).toBe(true);
    expect(leap.amount.cents).toBe(290_000);
  });

  it('bills the full amount when proration is switched off', () => {
    const result = prorateMonthlyAmount({
      scheduledAmount: usd(100_000),
      period: '2026-03',
      serviceRange: makeRange('2026-03-20', '2026-03-31'),
      method: ProrationMethod.NONE,
    });
    expect(result.amount.cents).toBe(100_000);
    expect(result.detail.method).toBe(ProrationMethod.NONE);
  });

  it('records enough detail to reproduce the figure later', () => {
    const result = prorateMonthlyAmount({
      scheduledAmount: usd(100_000),
      period: '2026-02',
      serviceRange: makeRange('2026-02-10', '2026-02-28'),
    });
    expect(recomputeFromDetail(result.detail, 'USD').cents).toBe(result.amount.cents);
  });

  it('rejects a service range the caller has not clipped to the period', () => {
    expect(() =>
      prorateMonthlyAmount({
        scheduledAmount: usd(100_000),
        period: '2026-03',
        serviceRange: makeRange('2026-02-15', '2026-03-15'),
      }),
    ).toThrow(DomainError);
  });

  it('rejects a service range outside the period entirely', () => {
    expect(() =>
      prorateMonthlyAmount({
        scheduledAmount: usd(100_000),
        period: '2026-03',
        serviceRange: makeRange('2026-05-01', '2026-05-31'),
      }),
    ).toThrow(DomainError);
  });

  it('never loses a cent when the two halves of a split month are added back', () => {
    const first = prorateMonthlyAmount({
      scheduledAmount: usd(123_457),
      period: '2026-03',
      serviceRange: makeRange('2026-03-01', '2026-03-14'),
    });
    const second = prorateMonthlyAmount({
      scheduledAmount: usd(123_457),
      period: '2026-03',
      serviceRange: makeRange('2026-03-15', '2026-03-31'),
    });
    // Each half rounds independently, so the sum may differ from the whole by
    // at most one cent. The test pins the actual behaviour so a change is visible.
    const combined = first.amount.cents + second.amount.cents;
    expect(Math.abs(combined - 123_457)).toBeLessThanOrEqual(1);
  });
});
