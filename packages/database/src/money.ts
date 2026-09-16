/**
 * Conversion between database money columns and the domain `Money` type.
 *
 * Money columns are `BIGINT` minor units. BigInt was chosen over INTEGER
 * because a 32-bit column tops out at 21,474,836.47 in a 2-decimal currency,
 * which a portfolio-level aggregate would exceed. It was chosen over
 * NUMERIC/Decimal because an integer cannot acquire a fractional part through
 * a careless operation.
 *
 * JavaScript numbers are used above this boundary, so every value crossing it
 * is checked against Number.MAX_SAFE_INTEGER (90,071,987,546,743.99 in a
 * 2-decimal currency). Exceeding that throws rather than silently truncating.
 */

import { DomainError, money, type Money } from '@rentwell/domain';

/** Converts a BIGINT column value to safe integer cents. */
export function centsFromDb(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new DomainError('INTERNAL_ERROR', `Money value ${value} is not a safe integer`);
    }
    return value;
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DomainError(
      'INTERNAL_ERROR',
      `Money value ${value.toString()} exceeds the range this application can represent exactly. ` +
        'This indicates corrupt data or an aggregate over far more records than expected.',
    );
  }
  return Number(value);
}

/** Converts safe integer cents to a BIGINT column value. */
export function centsToDb(value: number): bigint {
  if (!Number.isInteger(value)) {
    throw new DomainError('INVALID_MONEY', `Money must be integer cents, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new DomainError('INVALID_MONEY', `Money value ${value} exceeds the safe integer range`);
  }
  return BigInt(value);
}

/** Builds a domain Money from a column value and the record's currency. */
export function moneyFromDb(value: bigint | number | null | undefined, currency: string): Money {
  return money(centsFromDb(value), currency);
}

export function moneyToDb(value: Money): bigint {
  return centsToDb(value.cents);
}

/**
 * Sums a list of BIGINT column values safely. Prisma `_sum` returns null for an
 * empty set; this normalises that to zero.
 */
export function sumCentsFromDb(values: readonly (bigint | number | null)[]): number {
  let total = 0n;
  for (const value of values) {
    if (value === null) continue;
    total += typeof value === 'number' ? BigInt(value) : value;
  }
  return centsFromDb(total);
}
