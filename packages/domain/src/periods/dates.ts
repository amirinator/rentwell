/**
 * Calendar dates and accounting periods.
 *
 * Rentwell keeps three time concepts apart and never conflates them:
 *
 *  - **Business date** (`LocalDate`): the calendar day an event happened in the
 *    property's own timezone. Service periods, due dates and value dates are
 *    business dates. They have no time component and no offset.
 *  - **Instant** (`Date`): an absolute UTC timestamp. Every stored timestamp
 *    column is an instant. Used for "when did the system record this".
 *  - **Accounting period** (`PeriodKey`, `"YYYY-MM"`): the reporting bucket a
 *    posting belongs to. Derived from the posting date, never from the instant.
 *
 * Converting an instant to a business date requires a timezone, which always
 * comes from the property. There is no ambient local timezone in this codebase.
 */

/** A calendar date with no time or offset, formatted `YYYY-MM-DD`. */
export type LocalDate = string;

/** An accounting period key, formatted `YYYY-MM`. */
export type PeriodKey = string;

export interface DateParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD_PATTERN = /^(\d{4})-(\d{2})$/;

export class InvalidDateError extends Error {
  readonly code = 'INVALID_DATE';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDateError';
  }
}

export function isLocalDate(value: string): boolean {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

export function parseLocalDate(value: string): DateParts {
  if (!isLocalDate(value)) {
    throw new InvalidDateError(`Not a valid YYYY-MM-DD date: ${JSON.stringify(value)}`);
  }
  const match = LOCAL_DATE_PATTERN.exec(value)!;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function formatLocalDate(parts: DateParts): LocalDate {
  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) {
    throw new InvalidDateError(`Month must be between 1 and 12, received ${month}`);
  }
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1]!;
}

/**
 * Serial day number (days since 1970-01-01) for a calendar date. Computed with
 * `Date.UTC` so the calendar arithmetic is exact and offset-free.
 */
export function toEpochDay(value: LocalDate): number {
  const { year, month, day } = parseLocalDate(value);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function fromEpochDay(epochDay: number): LocalDate {
  const date = new Date(epochDay * 86_400_000);
  return formatLocalDate({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

export function addDays(value: LocalDate, days: number): LocalDate {
  return fromEpochDay(toEpochDay(value) + days);
}

export function addMonths(value: LocalDate, months: number): LocalDate {
  const { year, month, day } = parseLocalDate(value);
  const zeroBased = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = (zeroBased % 12) + 1;
  // Clamp: 2026-01-31 + 1 month is 2026-02-28, not 2026-03-03.
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return formatLocalDate({ year: targetYear, month: targetMonth, day: targetDay });
}

export function compareLocalDate(a: LocalDate, b: LocalDate): -1 | 0 | 1 {
  const left = toEpochDay(a);
  const right = toEpochDay(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function isBefore(a: LocalDate, b: LocalDate): boolean {
  return compareLocalDate(a, b) < 0;
}

export function isAfter(a: LocalDate, b: LocalDate): boolean {
  return compareLocalDate(a, b) > 0;
}

export function isOnOrBefore(a: LocalDate, b: LocalDate): boolean {
  return compareLocalDate(a, b) <= 0;
}

export function isOnOrAfter(a: LocalDate, b: LocalDate): boolean {
  return compareLocalDate(a, b) >= 0;
}

export function minLocalDate(a: LocalDate, b: LocalDate): LocalDate {
  return isBefore(a, b) ? a : b;
}

export function maxLocalDate(a: LocalDate, b: LocalDate): LocalDate {
  return isAfter(a, b) ? a : b;
}

/** Whole days from `a` to `b`. Negative when `b` precedes `a`. */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return toEpochDay(b) - toEpochDay(a);
}

/** An inclusive date range. `end` is a day the range contains. */
export interface DateRange {
  readonly start: LocalDate;
  readonly end: LocalDate;
}

export function makeRange(start: LocalDate, end: LocalDate): DateRange {
  if (isAfter(start, end)) {
    throw new InvalidDateError(`Range start ${start} is after end ${end}`);
  }
  return Object.freeze({ start, end });
}

/** Inclusive day count of a range. A single-day range counts 1. */
export function rangeLengthDays(range: DateRange): number {
  return daysBetween(range.start, range.end) + 1;
}

export function rangeContains(range: DateRange, value: LocalDate): boolean {
  return isOnOrAfter(value, range.start) && isOnOrBefore(value, range.end);
}

/** Intersection of two inclusive ranges, or null when they do not overlap. */
export function intersectRanges(a: DateRange, b: DateRange): DateRange | null {
  const start = maxLocalDate(a.start, b.start);
  const end = minLocalDate(a.end, b.end);
  if (isAfter(start, end)) return null;
  return makeRange(start, end);
}

/** Inclusive overlapping day count of two ranges. Zero when disjoint. */
export function overlapDays(a: DateRange, b: DateRange): number {
  const intersection = intersectRanges(a, b);
  return intersection === null ? 0 : rangeLengthDays(intersection);
}

// --------------------------------------------------------------------------
// Accounting periods
// --------------------------------------------------------------------------

export function isPeriodKey(value: string): boolean {
  const match = PERIOD_PATTERN.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

export function parsePeriodKey(value: string): { year: number; month: number } {
  if (!isPeriodKey(value)) {
    throw new InvalidDateError(`Not a valid YYYY-MM accounting period: ${JSON.stringify(value)}`);
  }
  const match = PERIOD_PATTERN.exec(value)!;
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function formatPeriodKey(year: number, month: number): PeriodKey {
  if (month < 1 || month > 12) {
    throw new InvalidDateError(`Month must be between 1 and 12, received ${month}`);
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/** The accounting period a business date falls in. */
export function periodOf(value: LocalDate): PeriodKey {
  const { year, month } = parseLocalDate(value);
  return formatPeriodKey(year, month);
}

export function periodStart(period: PeriodKey): LocalDate {
  const { year, month } = parsePeriodKey(period);
  return formatLocalDate({ year, month, day: 1 });
}

export function periodEnd(period: PeriodKey): LocalDate {
  const { year, month } = parsePeriodKey(period);
  return formatLocalDate({ year, month, day: daysInMonth(year, month) });
}

export function periodRange(period: PeriodKey): DateRange {
  return makeRange(periodStart(period), periodEnd(period));
}

export function periodDayCount(period: PeriodKey): number {
  const { year, month } = parsePeriodKey(period);
  return daysInMonth(year, month);
}

export function addPeriods(period: PeriodKey, count: number): PeriodKey {
  const { year, month } = parsePeriodKey(period);
  const zeroBased = year * 12 + (month - 1) + count;
  return formatPeriodKey(Math.floor(zeroBased / 12), (zeroBased % 12) + 1);
}

export function nextPeriod(period: PeriodKey): PeriodKey {
  return addPeriods(period, 1);
}

export function previousPeriod(period: PeriodKey): PeriodKey {
  return addPeriods(period, -1);
}

export function comparePeriods(a: PeriodKey, b: PeriodKey): -1 | 0 | 1 {
  const left = parsePeriodKey(a);
  const right = parsePeriodKey(b);
  const leftValue = left.year * 12 + left.month;
  const rightValue = right.year * 12 + right.month;
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

/** Inclusive list of period keys from `from` to `to`. */
export function periodsBetween(from: PeriodKey, to: PeriodKey): PeriodKey[] {
  if (comparePeriods(from, to) > 0) {
    throw new InvalidDateError(`Period range ${from}..${to} is inverted`);
  }
  const result: PeriodKey[] = [];
  let cursor = from;
  while (comparePeriods(cursor, to) <= 0) {
    result.push(cursor);
    cursor = nextPeriod(cursor);
  }
  return result;
}

// --------------------------------------------------------------------------
// Timezone conversion
// --------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      throw new InvalidDateError(`Unknown IANA timezone: ${JSON.stringify(timeZone)}`);
    }
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function zonedParts(
  instant: Date,
  timeZone: string,
): DateParts & { hour: number; minute: number; second: number } {
  const parts = zoneFormatter(timeZone).formatToParts(instant);
  const lookup: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = Number(part.value);
  }
  return {
    year: lookup.year!,
    month: lookup.month!,
    day: lookup.day!,
    hour: lookup.hour! % 24,
    minute: lookup.minute!,
    second: lookup.second!,
  };
}

/** The business date an instant falls on in the given property timezone. */
export function businessDateInZone(instant: Date, timeZone: string): LocalDate {
  const parts = zonedParts(instant, timeZone);
  return formatLocalDate(parts);
}

/**
 * The UTC instant of midnight at the start of a business date in `timeZone`.
 *
 * Resolves the offset by fixed-point iteration: guess the instant as if the
 * wall clock were UTC, measure the zone's actual offset at that instant, and
 * correct. Two passes settle every real-world zone including DST transitions;
 * on a spring-forward day where midnight does not exist locally, the result is
 * the first instant that does.
 */
export function startOfBusinessDayUtc(date: LocalDate, timeZone: string): Date {
  const { year, month, day } = parseLocalDate(date);
  const target = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const offset = asUtc - guess;
    const corrected = target - offset;
    if (corrected === guess) break;
    guess = corrected;
  }
  return new Date(guess);
}

/** The UTC instant immediately after the end of a business date in `timeZone`. */
export function endOfBusinessDayUtcExclusive(date: LocalDate, timeZone: string): Date {
  return startOfBusinessDayUtc(addDays(date, 1), timeZone);
}

/** Half-open UTC instant window `[start, end)` covering an accounting period. */
export function periodInstantWindow(
  period: PeriodKey,
  timeZone: string,
): { start: Date; endExclusive: Date } {
  return {
    start: startOfBusinessDayUtc(periodStart(period), timeZone),
    endExclusive: endOfBusinessDayUtcExclusive(periodEnd(period), timeZone),
  };
}

/**
 * Parses an untrusted date string from an import file. Accepts ISO
 * `YYYY-MM-DD` and the two unambiguous slash formats. Deliberately rejects
 * `MM/DD/YYYY` vs `DD/MM/YYYY` ambiguity by requiring ISO ordering for slashes.
 */
export function parseImportDate(raw: string): LocalDate {
  const text = raw.trim();
  if (text.length === 0) throw new InvalidDateError('Date is empty');

  const isoSlash = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(text);
  if (isoSlash) {
    const candidate = `${isoSlash[1]}-${isoSlash[2]}-${isoSlash[3]}`;
    if (!isLocalDate(candidate)) throw new InvalidDateError(`Not a real calendar date: ${text}`);
    return candidate;
  }

  // Accept a full ISO-8601 timestamp by taking its date portion verbatim; the
  // provider states the date it means, so no timezone shifting is applied.
  const isoTimestamp = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}/.exec(text);
  if (isoTimestamp) {
    const candidate = isoTimestamp[1]!;
    if (!isLocalDate(candidate)) throw new InvalidDateError(`Not a real calendar date: ${text}`);
    return candidate;
  }

  if (!isLocalDate(text)) {
    throw new InvalidDateError(`Unsupported date format ${JSON.stringify(raw)}. Use YYYY-MM-DD.`);
  }
  return text;
}
