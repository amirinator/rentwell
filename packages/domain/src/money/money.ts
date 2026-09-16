/**
 * Money values.
 *
 * Storage and transport use integer minor units ("cents"). A `Money` always
 * carries its currency so that a cross-currency operation fails loudly rather
 * than producing a plausible-looking wrong number. Version 1 configures USD as
 * the only supported currency, but the currency is never implicit.
 */

import { Decimal, dec, type RoundingMode } from './decimal';

/** ISO 4217 alphabetic code. Stored uppercase. */
export type CurrencyCode = string;

export interface Money {
  /** Signed integer minor units. Positive is a debit-normal increase. */
  readonly cents: number;
  readonly currency: CurrencyCode;
}

export const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = ['USD'];

/** Minor-unit exponent per currency. Version 1 only configures 2-decimal USD. */
const MINOR_UNIT_DIGITS: Record<string, number> = { USD: 2 };

export function minorUnitDigits(currency: CurrencyCode): number {
  return MINOR_UNIT_DIGITS[currency.toUpperCase()] ?? 2;
}

export class CurrencyMismatchError extends Error {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(
    readonly left: CurrencyCode,
    readonly right: CurrencyCode,
  ) {
    super(`Cannot combine ${left} with ${right}. Cross-currency operations are rejected.`);
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidMoneyError extends Error {
  readonly code = 'INVALID_MONEY';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export function normalizeCurrency(currency: string): CurrencyCode {
  const upper = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) {
    throw new InvalidMoneyError(
      `Currency must be a 3-letter ISO code, received ${JSON.stringify(currency)}`,
    );
  }
  return upper;
}

export function money(cents: number, currency: CurrencyCode): Money {
  if (!Number.isInteger(cents)) {
    throw new InvalidMoneyError(`Money requires integer minor units, received ${cents}`);
  }
  if (!Number.isSafeInteger(cents)) {
    throw new InvalidMoneyError(`Money value ${cents} exceeds the safe integer range`);
  }
  return Object.freeze({ cents, currency: normalizeCurrency(currency) });
}

export function zero(currency: CurrencyCode): Money {
  return money(0, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.cents + b.cents, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.cents - b.cents, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.cents, a.currency);
}

export function absolute(a: Money): Money {
  return a.cents < 0 ? negate(a) : a;
}

export function sum(values: readonly Money[], currency: CurrencyCode): Money {
  return values.reduce<Money>((acc, value) => add(acc, value), zero(currency));
}

export function isZero(a: Money): boolean {
  return a.cents === 0;
}

export function isPositive(a: Money): boolean {
  return a.cents > 0;
}

export function isNegative(a: Money): boolean {
  return a.cents < 0;
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.cents < b.cents) return -1;
  if (a.cents > b.cents) return 1;
  return 0;
}

export function equalsMoney(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.cents === b.cents;
}

export function minMoney(a: Money, b: Money): Money {
  return compareMoney(a, b) <= 0 ? a : b;
}

export function maxMoney(a: Money, b: Money): Money {
  return compareMoney(a, b) >= 0 ? a : b;
}

/** Converts to a Decimal in major units, for use in further exact arithmetic. */
export function toDecimal(value: Money): Decimal {
  return Decimal.ofUnits(BigInt(value.cents), minorUnitDigits(value.currency));
}

/** Rounds a major-unit Decimal to a Money value. Rounds exactly once. */
export function fromDecimal(
  value: Decimal,
  currency: CurrencyCode,
  mode: RoundingMode = 'HALF_UP',
): Money {
  return money(value.toCents(mode), currency);
}

/**
 * Parses a monetary literal from an untrusted source (CSV column, API input).
 *
 * Accepts an optional sign, optional thousands separators, optional currency
 * symbol, and parenthesised negatives as used by accounting exports. Rejects
 * scientific notation and any value with more decimal places than the currency
 * supports, because silently rounding an input would hide a bad file.
 */
export function parseAmountToCents(raw: string, currency: CurrencyCode): number {
  const normalizedCurrency = normalizeCurrency(currency);
  const digits = minorUnitDigits(normalizedCurrency);

  let text = raw.trim();
  if (text.length === 0) throw new InvalidMoneyError('Amount is empty');

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  // Strip a leading currency symbol. Escaped so the source stays pure ASCII.
  text = text.replace(/^[$£€¥]/, '').trim();
  text = text.replace(/\s/g, '');

  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }

  // Reject anything that is not a plain grouped decimal. This deliberately
  // rejects "1e5" and "1,23,456.78"-style groupings we do not support.
  if (!/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(text) && !/^\d+(\.\d+)?$/.test(text)) {
    throw new InvalidMoneyError(`Not a valid amount: ${JSON.stringify(raw)}`);
  }

  const withoutGrouping = text.replace(/,/g, '');
  const fractionDigits = withoutGrouping.includes('.') ? withoutGrouping.split('.')[1]!.length : 0;
  if (fractionDigits > digits) {
    throw new InvalidMoneyError(
      `Amount ${JSON.stringify(raw)} has ${fractionDigits} decimal places; ${normalizedCurrency} supports ${digits}.`,
    );
  }

  const parsed = dec(withoutGrouping);
  // Exact: fractionDigits <= digits, so no rounding occurs here.
  const cents = parsed.withScale(digits).units;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidMoneyError(`Amount ${JSON.stringify(raw)} exceeds the supported range`);
  }
  const value = Number(cents);
  return negative ? -value : value;
}

export function parseMoney(raw: string, currency: CurrencyCode): Money {
  return money(parseAmountToCents(raw, currency), currency);
}

/** Renders integer cents as a plain decimal string, e.g. -1234 -> "-12.34". */
export function formatCents(cents: number, currency: CurrencyCode = 'USD'): string {
  const digits = minorUnitDigits(currency);
  return Decimal.ofUnits(BigInt(cents), digits).toString();
}

export function formatMoney(value: Money): string {
  return `${formatCents(value.cents, value.currency)} ${value.currency}`;
}

/**
 * Splits `total` into `weights.length` parts proportional to the weights,
 * distributing the rounding remainder deterministically by largest fractional
 * part (ties broken by lowest index). The parts always sum exactly to `total`,
 * which is what keeps a multi-charge allocation from leaking a cent.
 */
export function allocateProportionally(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0)) {
    throw new InvalidMoneyError('Allocation weights must be non-negative');
  }
  const weightTotal = weights.reduce((acc, w) => acc + w, 0);
  if (weightTotal === 0) {
    throw new InvalidMoneyError('Allocation weights must not sum to zero');
  }

  const totalUnits = BigInt(total.cents);
  const weightSum = BigInt(weightTotal);

  const bases: bigint[] = [];
  const remainders: bigint[] = [];
  for (const weight of weights) {
    const product = totalUnits * BigInt(weight);
    // Truncate toward zero, then hand out the leftover units below.
    const quotient = product / weightSum;
    bases.push(quotient);
    remainders.push(product - quotient * weightSum);
  }

  const distributed = bases.reduce((acc, v) => acc + v, 0n);
  let leftover = totalUnits - distributed;
  const step = leftover < 0n ? -1n : 1n;

  const order = remainders
    .map((remainder, index) => ({ remainder: remainder < 0n ? -remainder : remainder, index }))
    .sort((a, b) => {
      if (a.remainder === b.remainder) return a.index - b.index;
      return a.remainder > b.remainder ? -1 : 1;
    });

  let cursor = 0;
  while (leftover !== 0n && order.length > 0) {
    const target = order[cursor % order.length]!.index;
    bases[target] = bases[target]! + step;
    leftover -= step;
    cursor += 1;
  }

  return bases.map((units) => money(Number(units), total.currency));
}
