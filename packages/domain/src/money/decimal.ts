/**
 * Fixed-point decimal arithmetic backed by BigInt.
 *
 * Rentwell never performs monetary arithmetic with binary floating point. Every
 * intermediate calculation (proration, percentage splits, allocation
 * remainders) runs through this type and is rounded exactly once, at the point
 * where a value becomes a persisted charge line or allocation amount.
 *
 * Representation: `units` is the unscaled integer value and `scale` is the
 * number of implied decimal places, so the mathematical value is
 * `units / 10^scale`.
 */

export type RoundingMode =
  /** 0.5 rounds away from zero. The configured default for charge lines. */
  | 'HALF_UP'
  /** 0.5 rounds to the nearest even digit. Reduces bias over many lines. */
  | 'HALF_EVEN'
  /** Truncates toward zero. */
  | 'DOWN'
  /** Rounds away from zero whenever there is any remainder. */
  | 'UP'
  /** Rounds toward negative infinity. */
  | 'FLOOR'
  /** Rounds toward positive infinity. */
  | 'CEILING';

/** Scale used for intermediate results before a single final rounding step. */
export const INTERMEDIATE_SCALE = 12;

const TEN = 10n;

function pow10(exponent: number): bigint {
  if (exponent < 0) throw new RangeError(`pow10 requires a non-negative exponent, got ${exponent}`);
  let result = 1n;
  for (let i = 0; i < exponent; i += 1) result *= TEN;
  return result;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

const DECIMAL_PATTERN = /^[+-]?(\d+)(\.(\d+))?$/;

export class Decimal {
  readonly units: bigint;
  readonly scale: number;

  private constructor(units: bigint, scale: number) {
    if (!Number.isInteger(scale) || scale < 0) {
      throw new RangeError(`Decimal scale must be a non-negative integer, got ${scale}`);
    }
    this.units = units;
    this.scale = scale;
  }

  static readonly ZERO = new Decimal(0n, 0);
  static readonly ONE = new Decimal(1n, 0);

  /** Builds a Decimal from an unscaled integer and an explicit scale. */
  static ofUnits(units: bigint | number, scale: number): Decimal {
    const asBigInt = typeof units === 'number' ? Decimal.safeIntegerToBigInt(units) : units;
    return new Decimal(asBigInt, scale);
  }

  /** Builds a Decimal from an exact integer. Rejects non-integers outright. */
  static ofInteger(value: bigint | number): Decimal {
    if (typeof value === 'number') return new Decimal(Decimal.safeIntegerToBigInt(value), 0);
    return new Decimal(value, 0);
  }

  /**
   * Parses an exact decimal string such as "1234.56". Strings are the only
   * accepted textual source of a monetary value; `number` literals with
   * fractional parts are deliberately not accepted because they may already
   * have lost precision before reaching this call.
   */
  static parse(text: string): Decimal {
    const trimmed = text.trim();
    const match = DECIMAL_PATTERN.exec(trimmed);
    if (!match) throw new TypeError(`Not a valid decimal literal: ${JSON.stringify(text)}`);
    const negative = trimmed.startsWith('-');
    const whole = match[1] ?? '0';
    const fraction = match[3] ?? '';
    const units = BigInt(whole + fraction);
    return new Decimal(negative ? -units : units, fraction.length);
  }

  private static safeIntegerToBigInt(value: number): bigint {
    if (!Number.isInteger(value)) {
      throw new TypeError(
        `Expected an integer, received ${value}. Use Decimal.parse for fractional values.`,
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`Integer ${value} exceeds the safe integer range.`);
    }
    return BigInt(value);
  }

  /** Re-expresses this value at `scale`, which must not lose precision. */
  withScale(scale: number): Decimal {
    if (scale === this.scale) return this;
    if (scale > this.scale) {
      return new Decimal(this.units * pow10(scale - this.scale), scale);
    }
    const divisor = pow10(this.scale - scale);
    if (this.units % divisor !== 0n) {
      throw new RangeError(
        `Reducing scale ${this.scale} -> ${scale} would discard precision. Use round() instead.`,
      );
    }
    return new Decimal(this.units / divisor, scale);
  }

  private static align(a: Decimal, b: Decimal): [bigint, bigint, number] {
    const scale = Math.max(a.scale, b.scale);
    return [a.units * pow10(scale - a.scale), b.units * pow10(scale - b.scale), scale];
  }

  plus(other: Decimal): Decimal {
    const [x, y, scale] = Decimal.align(this, other);
    return new Decimal(x + y, scale);
  }

  minus(other: Decimal): Decimal {
    const [x, y, scale] = Decimal.align(this, other);
    return new Decimal(x - y, scale);
  }

  times(other: Decimal): Decimal {
    return new Decimal(this.units * other.units, this.scale + other.scale);
  }

  negated(): Decimal {
    return new Decimal(-this.units, this.scale);
  }

  absoluteValue(): Decimal {
    return this.units < 0n ? this.negated() : this;
  }

  /**
   * Divides at `scale` digits of precision using the given rounding mode.
   * Division is never exact in general, so the caller states the precision it
   * wants; proration uses {@link INTERMEDIATE_SCALE} and rounds to cents later.
   */
  dividedBy(other: Decimal, scale = INTERMEDIATE_SCALE, mode: RoundingMode = 'HALF_EVEN'): Decimal {
    if (other.units === 0n) throw new RangeError('Division by zero');
    // (thisUnits / 10^thisScale) / (otherUnits / 10^otherScale), at target scale.
    const numerator = this.units * pow10(other.scale + scale);
    const denominator = other.units * pow10(this.scale);
    return new Decimal(divideRounded(numerator, denominator, mode), scale);
  }

  compare(other: Decimal): -1 | 0 | 1 {
    const [x, y] = Decimal.align(this, other);
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  }

  equals(other: Decimal): boolean {
    return this.compare(other) === 0;
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  isPositive(): boolean {
    return this.units > 0n;
  }

  /** Rounds to `scale` decimal places using the given mode. */
  round(scale: number, mode: RoundingMode = 'HALF_UP'): Decimal {
    if (scale >= this.scale) return this.withScale(scale);
    const divisor = pow10(this.scale - scale);
    return new Decimal(divideRounded(this.units, divisor, mode), scale);
  }

  /**
   * Rounds to a whole number of minor units (cents) and returns a JavaScript
   * number. Throws rather than silently losing precision if the result exceeds
   * the safe integer range.
   */
  toCents(mode: RoundingMode = 'HALF_UP'): number {
    const rounded = this.round(2, mode).withScale(2);
    const cents = rounded.units;
    if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(`Rounded value ${rounded.toString()} exceeds the safe cent range.`);
    }
    return Number(cents);
  }

  toString(): string {
    if (this.scale === 0) return this.units.toString();
    const negative = this.units < 0n;
    const digits = abs(this.units)
      .toString()
      .padStart(this.scale + 1, '0');
    const whole = digits.slice(0, digits.length - this.scale);
    const fraction = digits.slice(digits.length - this.scale);
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/**
 * Integer division with the requested rounding mode. Sign handling is explicit
 * so FLOOR and CEILING behave correctly for negative values, which occur on
 * credits and reversals.
 */
function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero');

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = abs(numerator);
  const absDenominator = abs(denominator);

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  if (remainder === 0n) return negative ? -quotient : quotient;

  const twiceRemainder = remainder * 2n;
  let magnitude: bigint;

  switch (mode) {
    case 'DOWN':
      magnitude = quotient;
      break;
    case 'UP':
      magnitude = quotient + 1n;
      break;
    case 'FLOOR':
      magnitude = negative ? quotient + 1n : quotient;
      break;
    case 'CEILING':
      magnitude = negative ? quotient : quotient + 1n;
      break;
    case 'HALF_UP':
      magnitude = twiceRemainder >= absDenominator ? quotient + 1n : quotient;
      break;
    case 'HALF_EVEN': {
      if (twiceRemainder > absDenominator) magnitude = quotient + 1n;
      else if (twiceRemainder < absDenominator) magnitude = quotient;
      else magnitude = quotient % 2n === 0n ? quotient : quotient + 1n;
      break;
    }
    default: {
      const exhaustive: never = mode;
      throw new TypeError(`Unsupported rounding mode: ${String(exhaustive)}`);
    }
  }

  return negative ? -magnitude : magnitude;
}

/** Convenience constructor. Accepts an exact decimal string or an integer. */
export function dec(value: string | number | bigint): Decimal {
  if (typeof value === 'string') return Decimal.parse(value);
  return Decimal.ofInteger(value);
}
