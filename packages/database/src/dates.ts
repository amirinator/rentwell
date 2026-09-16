/**
 * Conversion between PostgreSQL `date` columns and the domain `LocalDate`.
 *
 * The `pg` driver hands a `date` column back as a JavaScript `Date` set to
 * midnight **UTC**. Reading it with `getFullYear()` would shift the day for any
 * server west of Greenwich, so every read goes through `localDateFromDb`, which
 * only ever reads UTC components. Writes mirror that: a `LocalDate` becomes
 * midnight UTC, which round-trips exactly.
 *
 * This is why `@db.Date` columns and `@db.Timestamptz` columns are never mixed:
 * a business date has no time and no offset, and giving it one invents
 * information the source never supplied.
 */

import {
  InvalidDateError,
  formatLocalDate,
  parseLocalDate,
  type LocalDate,
} from '@rentwell/domain';

/** Reads a `date` column as a LocalDate, using UTC components only. */
export function localDateFromDb(value: Date | null | undefined): LocalDate | null {
  if (value === null || value === undefined) return null;
  if (Number.isNaN(value.getTime())) {
    throw new InvalidDateError('Received an invalid Date from the database');
  }
  return formatLocalDate({
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  });
}

/** Reads a `date` column that the schema declares NOT NULL. */
export function requireLocalDateFromDb(value: Date | null | undefined): LocalDate {
  const result = localDateFromDb(value);
  if (result === null) throw new InvalidDateError('Expected a date column to be present');
  return result;
}

/** Writes a LocalDate to a `date` column as midnight UTC. */
export function localDateToDb(value: LocalDate): Date {
  const { year, month, day } = parseLocalDate(value);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

export function optionalLocalDateToDb(value: LocalDate | null | undefined): Date | null {
  return value === null || value === undefined ? null : localDateToDb(value);
}
