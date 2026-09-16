/**
 * Money at the API boundary.
 *
 * `toGqlMoney` is the only way a monetary value becomes a GraphQL `Money`. It
 * takes integer cents and a currency and produces all three fields, so a
 * formatted string can never disagree with the cents it claims to represent.
 */

import { centsFromDb } from '@rentwell/database';
import { formatCents, type Money } from '@rentwell/domain';
import type { GqlMoney } from '@rentwell/graphql';

/** Thousands-separated display form, e.g. -1234567 -> "-12,345.67". */
export function formatForDisplay(cents: number, currency: string): string {
  const plain = formatCents(cents, currency);
  const negative = plain.startsWith('-');
  const unsigned = negative ? plain.slice(1) : plain;
  const [whole, fraction] = unsigned.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

export function toGqlMoney(cents: number, currency: string): GqlMoney {
  return { cents, currency, formatted: formatForDisplay(cents, currency) };
}

export function moneyToGql(value: Money): GqlMoney {
  return toGqlMoney(value.cents, value.currency);
}

/** Converts a BIGINT column value straight to a GraphQL Money. */
export function dbMoneyToGql(
  value: bigint | number | null | undefined,
  currency: string,
): GqlMoney {
  return toGqlMoney(centsFromDb(value), currency);
}

export function zeroMoney(currency: string): GqlMoney {
  return toGqlMoney(0, currency);
}
