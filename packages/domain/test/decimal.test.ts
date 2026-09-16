import { describe, expect, it } from 'vitest';
import { Decimal, dec, INTERMEDIATE_SCALE } from '../src/money/decimal';

describe('Decimal parsing and formatting', () => {
  it('parses an exact decimal literal without losing precision', () => {
    const value = dec('1234.56');
    expect(value.units).toBe(123456n);
    expect(value.scale).toBe(2);
    expect(value.toString()).toBe('1234.56');
  });

  it('round-trips negative values below one', () => {
    expect(dec('-0.05').toString()).toBe('-0.05');
    expect(dec('-0.05').units).toBe(-5n);
  });

  it('keeps trailing zeros that the source stated', () => {
    expect(dec('10.00').toString()).toBe('10.00');
    expect(dec('10.00').scale).toBe(2);
  });

  it('rejects literals that are not exact decimals', () => {
    expect(() => dec('1e5')).toThrow(TypeError);
    expect(() => dec('1,000')).toThrow(TypeError);
    expect(() => dec('abc')).toThrow(TypeError);
  });

  it('refuses fractional JavaScript numbers, which may already be imprecise', () => {
    expect(() => Decimal.ofInteger(1.5)).toThrow(TypeError);
    expect(Decimal.ofInteger(15).toString()).toBe('15');
  });
});

describe('Decimal arithmetic', () => {
  it('adds values of differing scale exactly', () => {
    expect(dec('0.1').plus(dec('0.2')).toString()).toBe('0.3');
    expect(dec('1.005').plus(dec('2.1')).toString()).toBe('3.105');
  });

  it('does not reproduce binary floating point error', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754 doubles.
    expect(dec('0.1').plus(dec('0.2')).equals(dec('0.3'))).toBe(true);
  });

  it('multiplies by summing scales', () => {
    const product = dec('1.5').times(dec('2.25'));
    expect(product.scale).toBe(3);
    expect(product.toString()).toBe('3.375');
  });

  it('divides at the requested precision', () => {
    expect(dec('10').dividedBy(dec('3')).scale).toBe(INTERMEDIATE_SCALE);
    expect(dec('10').dividedBy(dec('3')).toString()).toBe('3.333333333333');
  });

  it('rejects division by zero', () => {
    expect(() => dec('1').dividedBy(dec('0'))).toThrow(RangeError);
  });
});

describe('Decimal rounding modes', () => {
  it('HALF_UP rounds a tie away from zero in both directions', () => {
    expect(dec('2.5').round(0, 'HALF_UP').toString()).toBe('3');
    expect(dec('-2.5').round(0, 'HALF_UP').toString()).toBe('-3');
  });

  it('HALF_EVEN rounds a tie to the nearest even digit', () => {
    expect(dec('2.5').round(0, 'HALF_EVEN').toString()).toBe('2');
    expect(dec('3.5').round(0, 'HALF_EVEN').toString()).toBe('4');
  });

  it('FLOOR and CEILING respect sign', () => {
    expect(dec('-2.5').round(0, 'FLOOR').toString()).toBe('-3');
    expect(dec('-2.5').round(0, 'CEILING').toString()).toBe('-2');
    expect(dec('2.1').round(0, 'CEILING').toString()).toBe('3');
    expect(dec('2.9').round(0, 'FLOOR').toString()).toBe('2');
  });

  it('DOWN truncates toward zero and UP moves away from it', () => {
    expect(dec('2.9').round(0, 'DOWN').toString()).toBe('2');
    expect(dec('-2.9').round(0, 'DOWN').toString()).toBe('-2');
    expect(dec('2.1').round(0, 'UP').toString()).toBe('3');
    expect(dec('-2.1').round(0, 'UP').toString()).toBe('-3');
  });

  it('converts to cents with a single rounding step', () => {
    expect(dec('12.345').toCents()).toBe(1235);
    expect(dec('12.344').toCents()).toBe(1234);
    expect(dec('-12.345').toCents()).toBe(-1235);
  });
});

describe('Decimal scale handling', () => {
  it('widens scale without changing the value', () => {
    expect(dec('1.5').withScale(6).toString()).toBe('1.500000');
    expect(dec('1.5').withScale(6).equals(dec('1.5'))).toBe(true);
  });

  it('refuses to narrow scale when precision would be lost', () => {
    expect(() => dec('1.55').withScale(1)).toThrow(RangeError);
    expect(dec('1.50').withScale(1).toString()).toBe('1.5');
  });

  it('compares across scales', () => {
    expect(dec('1.50').compare(dec('1.5'))).toBe(0);
    expect(dec('1.50').compare(dec('1.51'))).toBe(-1);
    expect(dec('1.52').compare(dec('1.51'))).toBe(1);
  });
});
