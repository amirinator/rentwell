import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  add,
  allocateProportionally,
  compareMoney,
  formatCents,
  formatMoney,
  money,
  parseAmountToCents,
  subtract,
  sum,
  toDecimal,
  fromDecimal,
} from '../src/money/money';
import { dec } from '../src/money/decimal';

describe('Money construction', () => {
  it('requires integer minor units', () => {
    expect(() => money(10.5, 'USD')).toThrow(InvalidMoneyError);
    expect(money(1050, 'USD').cents).toBe(1050);
  });

  it('normalises the currency code', () => {
    expect(money(100, 'usd').currency).toBe('USD');
    expect(() => money(100, 'DOLLARS')).toThrow(InvalidMoneyError);
  });

  it('refuses to combine currencies', () => {
    expect(() => add(money(100, 'USD'), money(100, 'EUR'))).toThrow(CurrencyMismatchError);
    expect(() => compareMoney(money(100, 'USD'), money(100, 'EUR'))).toThrow(CurrencyMismatchError);
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts in minor units', () => {
    expect(add(money(1050, 'USD'), money(2575, 'USD')).cents).toBe(3625);
    expect(subtract(money(1050, 'USD'), money(2575, 'USD')).cents).toBe(-1525);
  });

  it('sums an empty list to zero in the stated currency', () => {
    const total = sum([], 'USD');
    expect(total.cents).toBe(0);
    expect(total.currency).toBe('USD');
  });

  it('converts to and from Decimal without drift', () => {
    const value = money(123456, 'USD');
    expect(toDecimal(value).toString()).toBe('1234.56');
    expect(fromDecimal(dec('1234.56'), 'USD').cents).toBe(123456);
  });
});

describe('parseAmountToCents', () => {
  it('accepts plain and grouped decimals', () => {
    expect(parseAmountToCents('1234.56', 'USD')).toBe(123456);
    expect(parseAmountToCents('1,234.56', 'USD')).toBe(123456);
    expect(parseAmountToCents('1000', 'USD')).toBe(100000);
    expect(parseAmountToCents('$1,000.00', 'USD')).toBe(100000);
  });

  it('accepts accounting-style negatives', () => {
    expect(parseAmountToCents('-50.00', 'USD')).toBe(-5000);
    expect(parseAmountToCents('(50.00)', 'USD')).toBe(-5000);
  });

  it('rejects more decimal places than the currency supports', () => {
    // Silently rounding here would hide a malformed export file.
    expect(() => parseAmountToCents('1.234', 'USD')).toThrow(InvalidMoneyError);
  });

  it('rejects scientific notation and junk', () => {
    expect(() => parseAmountToCents('1e5', 'USD')).toThrow(InvalidMoneyError);
    expect(() => parseAmountToCents('', 'USD')).toThrow(InvalidMoneyError);
    expect(() => parseAmountToCents('12.34.56', 'USD')).toThrow(InvalidMoneyError);
    expect(() => parseAmountToCents('one hundred', 'USD')).toThrow(InvalidMoneyError);
  });
});

describe('formatting', () => {
  it('renders cents as a plain decimal string', () => {
    expect(formatCents(123456)).toBe('1234.56');
    expect(formatCents(-1234)).toBe('-12.34');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(0)).toBe('0.00');
  });

  it('includes the currency in formatMoney', () => {
    expect(formatMoney(money(-1234, 'USD'))).toBe('-12.34 USD');
  });
});

describe('allocateProportionally', () => {
  it('distributes an indivisible remainder without losing a cent', () => {
    const parts = allocateProportionally(money(1000, 'USD'), [1, 1, 1]);
    expect(parts.map((part) => part.cents)).toEqual([334, 333, 333]);
    expect(parts.reduce((acc, part) => acc + part.cents, 0)).toBe(1000);
  });

  it('respects unequal weights', () => {
    const parts = allocateProportionally(money(10000, 'USD'), [3, 1]);
    expect(parts.map((part) => part.cents)).toEqual([7500, 2500]);
  });

  it('keeps the total exact for awkward splits', () => {
    const parts = allocateProportionally(money(10001, 'USD'), [1, 1, 1, 1, 1, 1, 1]);
    expect(parts.reduce((acc, part) => acc + part.cents, 0)).toBe(10001);
  });

  it('handles negative totals, as used by reversals', () => {
    const parts = allocateProportionally(money(-1000, 'USD'), [1, 1, 1]);
    expect(parts.reduce((acc, part) => acc + part.cents, 0)).toBe(-1000);
  });

  it('rejects weights that sum to zero', () => {
    expect(() => allocateProportionally(money(100, 'USD'), [0, 0])).toThrow(InvalidMoneyError);
  });
});
