/**
 * Custom scalars.
 *
 * Each one exists to stop a specific class of mistake at the API boundary:
 *
 *  - `SafeInt` refuses any integer JavaScript cannot represent exactly, so a
 *    money value can never silently lose precision in transit.
 *  - `Date` and `DateTime` are distinct types, so a business date cannot be
 *    handed to something expecting an instant, or vice versa.
 *  - `Period` validates `YYYY-MM` at the edge rather than in every resolver.
 *  - `JSON` is deliberately depth- and size-limited: it carries calculation
 *    detail and audit metadata, not arbitrary client input.
 */

import { GraphQLError, GraphQLScalarType, Kind, type ValueNode } from 'graphql';
import { isLocalDate, isPeriodKey } from '@rentwell/domain';

function invalid(message: string): never {
  throw new GraphQLError(message, { extensions: { code: 'VALIDATION_FAILED' } });
}

export const SafeIntScalar = new GraphQLScalarType<number, number>({
  name: 'SafeInt',
  description:
    'An integer within the range JavaScript represents exactly (±2^53−1). Money is transported as minor units of this type.',
  serialize(value) {
    const numeric = typeof value === 'bigint' ? Number(value) : value;
    if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric)) {
      invalid(`SafeInt cannot represent ${String(value)}`);
    }
    return numeric;
  },
  parseValue(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      invalid(`SafeInt expects an exact integer, received ${String(value)}`);
    }
    return value;
  },
  parseLiteral(node: ValueNode) {
    if (node.kind !== Kind.INT) invalid('SafeInt expects an integer literal');
    const parsed = Number.parseInt(node.value, 10);
    if (!Number.isSafeInteger(parsed)) invalid(`SafeInt cannot represent ${node.value}`);
    return parsed;
  },
});

export const DateScalar = new GraphQLScalarType<string, string>({
  name: 'Date',
  description: 'A calendar date in YYYY-MM-DD with no time and no offset.',
  serialize(value) {
    if (value instanceof Date) {
      // `@db.Date` columns arrive as midnight UTC; read UTC components only.
      const year = String(value.getUTCFullYear()).padStart(4, '0');
      const month = String(value.getUTCMonth() + 1).padStart(2, '0');
      const day = String(value.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    if (typeof value === 'string' && isLocalDate(value)) return value;
    invalid(`Date cannot serialize ${String(value)}`);
  },
  parseValue(value) {
    if (typeof value !== 'string' || !isLocalDate(value)) {
      invalid(`Date expects YYYY-MM-DD, received ${String(value)}`);
    }
    return value;
  },
  parseLiteral(node) {
    if (node.kind !== Kind.STRING || !isLocalDate(node.value)) {
      invalid('Date expects a YYYY-MM-DD string literal');
    }
    return node.value;
  },
});

export const DateTimeScalar = new GraphQLScalarType<string, string>({
  name: 'DateTime',
  description: 'An instant in ISO-8601, always UTC.',
  serialize(value) {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) invalid('DateTime received an invalid Date');
      return value.toISOString();
    }
    if (typeof value === 'string') {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) invalid(`DateTime cannot serialize ${value}`);
      return parsed.toISOString();
    }
    invalid(`DateTime cannot serialize ${String(value)}`);
  },
  parseValue(value) {
    if (typeof value !== 'string') invalid('DateTime expects an ISO-8601 string');
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) invalid(`DateTime cannot parse ${value}`);
    return parsed.toISOString();
  },
  parseLiteral(node) {
    if (node.kind !== Kind.STRING) invalid('DateTime expects a string literal');
    const parsed = new Date(node.value);
    if (Number.isNaN(parsed.getTime())) invalid(`DateTime cannot parse ${node.value}`);
    return parsed.toISOString();
  },
});

export const PeriodScalar = new GraphQLScalarType<string, string>({
  name: 'Period',
  description: 'An accounting period in YYYY-MM.',
  serialize(value) {
    if (typeof value === 'string' && isPeriodKey(value)) return value;
    invalid(`Period cannot serialize ${String(value)}`);
  },
  parseValue(value) {
    if (typeof value !== 'string' || !isPeriodKey(value)) {
      invalid(`Period expects YYYY-MM, received ${String(value)}`);
    }
    return value;
  },
  parseLiteral(node) {
    if (node.kind !== Kind.STRING || !isPeriodKey(node.value)) {
      invalid('Period expects a YYYY-MM string literal');
    }
    return node.value;
  },
});

/** Guards against a deeply nested or oversized JSON literal in a query. */
const MAX_JSON_DEPTH = 12;
const MAX_JSON_BYTES = 256 * 1024;

function parseJsonLiteral(node: ValueNode, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) invalid(`JSON literal exceeds the depth limit of ${MAX_JSON_DEPTH}`);

  switch (node.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return node.value;
    case Kind.INT:
      return Number.parseInt(node.value, 10);
    case Kind.FLOAT:
      // Not a money path: JSON literals carry ranking scores and free-form
      // metadata. Monetary values use the SafeInt scalar.
      // eslint-disable-next-line no-restricted-syntax
      return Number.parseFloat(node.value);
    case Kind.OBJECT: {
      const result: Record<string, unknown> = {};
      for (const field of node.fields) {
        result[field.name.value] = parseJsonLiteral(field.value, depth + 1);
      }
      return result;
    }
    case Kind.LIST:
      return node.values.map((value) => parseJsonLiteral(value, depth + 1));
    case Kind.NULL:
      return null;
    default:
      invalid(`JSON cannot parse a ${node.kind} literal`);
  }
}

export const JSONScalar = new GraphQLScalarType<unknown, unknown>({
  name: 'JSON',
  description:
    'Structured detail such as a proration calculation or audit metadata. Size- and depth-limited; not a general-purpose escape hatch.',
  serialize(value) {
    // BigInt reaches here through money-adjacent metadata and is not JSON-safe.
    const normalized = replaceBigInt(value);
    const encoded = JSON.stringify(normalized);
    if (encoded !== undefined && encoded.length > MAX_JSON_BYTES) {
      invalid('JSON value exceeds the size limit');
    }
    return normalized;
  },
  parseValue(value) {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined && encoded.length > MAX_JSON_BYTES) {
      invalid('JSON value exceeds the size limit');
    }
    return value;
  },
  parseLiteral(node) {
    return parseJsonLiteral(node);
  },
});

function replaceBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(replaceBigInt);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = replaceBigInt(item);
    }
    return result;
  }
  return value;
}

/** Scalar resolver map, spread into the server's resolvers. */
export const scalarResolvers = {
  SafeInt: SafeIntScalar,
  Date: DateScalar,
  DateTime: DateTimeScalar,
  Period: PeriodScalar,
  JSON: JSONScalar,
};
