import { describe, expect, it } from 'vitest';
import {
  InvalidDateError,
  addDays,
  addMonths,
  businessDateInZone,
  comparePeriods,
  daysBetween,
  daysInMonth,
  endOfBusinessDayUtcExclusive,
  intersectRanges,
  isLeapYear,
  isLocalDate,
  makeRange,
  overlapDays,
  parseImportDate,
  periodEnd,
  periodInstantWindow,
  periodOf,
  periodStart,
  periodsBetween,
  rangeLengthDays,
  startOfBusinessDayUtc,
} from '../src/periods/dates';

describe('calendar arithmetic', () => {
  it('validates real calendar dates', () => {
    expect(isLocalDate('2026-03-15')).toBe(true);
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2024-02-29')).toBe(true);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2026-3-1')).toBe(false);
  });

  it('knows leap years', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-03-31', 1)).toBe('2026-04-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(daysBetween('2026-03-01', '2026-03-31')).toBe(30);
  });

  it('clamps when adding months to a month-end date', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-03-15', -3)).toBe('2025-12-15');
  });
});

describe('inclusive ranges', () => {
  it('counts a single-day range as one day', () => {
    expect(rangeLengthDays(makeRange('2026-03-05', '2026-03-05'))).toBe(1);
  });

  it('counts a whole month inclusively', () => {
    expect(rangeLengthDays(makeRange('2026-03-01', '2026-03-31'))).toBe(31);
  });

  it('intersects overlapping ranges', () => {
    const overlap = intersectRanges(
      makeRange('2026-03-01', '2026-03-31'),
      makeRange('2026-03-10', '2026-04-05'),
    );
    expect(overlap).toEqual({ start: '2026-03-10', end: '2026-03-31' });
    expect(
      overlapDays(makeRange('2026-03-01', '2026-03-31'), makeRange('2026-03-10', '2026-04-05')),
    ).toBe(22);
  });

  it('returns null for disjoint ranges', () => {
    expect(
      intersectRanges(makeRange('2026-01-01', '2026-01-31'), makeRange('2026-02-01', '2026-02-28')),
    ).toBeNull();
  });

  it('rejects an inverted range', () => {
    expect(() => makeRange('2026-03-31', '2026-03-01')).toThrow(InvalidDateError);
  });
});

describe('accounting periods', () => {
  it('derives the period from a business date', () => {
    expect(periodOf('2026-03-15')).toBe('2026-03');
    expect(periodStart('2026-03')).toBe('2026-03-01');
    expect(periodEnd('2026-02')).toBe('2026-02-28');
    expect(periodEnd('2024-02')).toBe('2024-02-29');
  });

  it('orders periods', () => {
    expect(comparePeriods('2026-01', '2026-02')).toBe(-1);
    expect(comparePeriods('2026-01', '2026-01')).toBe(0);
    expect(comparePeriods('2027-01', '2026-12')).toBe(1);
  });

  it('enumerates a period range inclusively across a year boundary', () => {
    expect(periodsBetween('2025-11', '2026-02')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });
});

describe('timezone conversion', () => {
  it('derives the business date in the property timezone, not the server zone', () => {
    // 03:30 UTC on 15 March is still 14 March in New York (UTC-4 under EDT).
    const instant = new Date('2026-03-15T03:30:00.000Z');
    expect(businessDateInZone(instant, 'America/New_York')).toBe('2026-03-14');
    expect(businessDateInZone(instant, 'UTC')).toBe('2026-03-15');
    expect(businessDateInZone(instant, 'Asia/Tokyo')).toBe('2026-03-15');
  });

  it('resolves midnight local time to the right UTC instant', () => {
    expect(startOfBusinessDayUtc('2026-03-15', 'America/New_York').toISOString()).toBe(
      '2026-03-15T04:00:00.000Z',
    );
    // 1 February is outside US daylight saving, so the offset is UTC-5.
    expect(startOfBusinessDayUtc('2026-02-01', 'America/New_York').toISOString()).toBe(
      '2026-02-01T05:00:00.000Z',
    );
    expect(startOfBusinessDayUtc('2026-03-15', 'UTC').toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    );
  });

  it('produces a half-open instant window for a period', () => {
    const window = periodInstantWindow('2026-02', 'UTC');
    expect(window.start.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(window.endExclusive.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(endOfBusinessDayUtcExclusive('2026-02-28', 'UTC').toISOString()).toBe(
      '2026-03-01T00:00:00.000Z',
    );
  });
});

describe('parseImportDate', () => {
  it('accepts ISO dates and ISO-ordered slashes', () => {
    expect(parseImportDate('2026-03-15')).toBe('2026-03-15');
    expect(parseImportDate('2026/03/15')).toBe('2026-03-15');
    expect(parseImportDate('2026-03-15T14:22:00Z')).toBe('2026-03-15');
  });

  it('rejects ambiguous day/month orderings outright', () => {
    // 03/15/2026 and 15/03/2026 cannot be told apart safely, so neither is accepted.
    expect(() => parseImportDate('03/15/2026')).toThrow(InvalidDateError);
    expect(() => parseImportDate('15/03/2026')).toThrow(InvalidDateError);
  });

  it('rejects impossible dates', () => {
    expect(() => parseImportDate('2026-02-30')).toThrow(InvalidDateError);
    expect(() => parseImportDate('')).toThrow(InvalidDateError);
  });
});
