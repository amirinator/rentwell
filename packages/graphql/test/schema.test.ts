/**
 * Schema contract tests.
 *
 * These check the three things that silently break a GraphQL API: an SDL that
 * no longer parses, an enum that has drifted from the domain, and a scalar that
 * accepts a value it should reject.
 */

import { buildSchema, GraphQLEnumType, GraphQLError, GraphQLObjectType } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  ChargeStatus,
  ChargeType,
  ExceptionCategory,
  ExceptionResolution,
  ExceptionSeverity,
  ExceptionStatus,
  ImportStatus,
  JournalEventType,
  LedgerAccountCode,
  MatchStrategy,
  OccupancyStatus,
  PeriodStatus,
  PropertyStatus,
  Role,
  SuggestionStatus,
  TransactionDirection,
  TransactionSource,
  TransactionStatus,
  AllocationStatus,
  AssistantRunStatus,
} from '@rentwell/domain';
import { loadTypeDefs } from '../src/schema';
import {
  DateScalar,
  DateTimeScalar,
  JSONScalar,
  PeriodScalar,
  SafeIntScalar,
  scalarResolvers,
} from '../src/scalars';
import { clampPageSize, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../src/types';

const sdl = loadTypeDefs();
const schema = buildSchema(sdl);

describe('SDL', () => {
  it('parses and builds', () => {
    expect(schema.getQueryType()).toBeDefined();
    expect(schema.getMutationType()).toBeDefined();
  });

  it('declares every scalar the resolvers provide', () => {
    for (const name of Object.keys(scalarResolvers)) {
      expect(schema.getType(name), `scalar ${name} missing from the SDL`).toBeDefined();
    }
  });

  it('exposes every query named in the specification', () => {
    const queries = Object.keys((schema.getQueryType() as GraphQLObjectType).getFields());
    for (const name of [
      'portfolioSummary',
      'properties',
      'property',
      'receivables',
      'importBatch',
      'transactions',
      'matchSuggestions',
      'exception',
      'closeReadiness',
      'journalEntries',
      'auditEvents',
    ]) {
      expect(queries, `query ${name} is missing`).toContain(name);
    }
  });

  it('exposes every mutation named in the specification', () => {
    const mutations = Object.keys((schema.getMutationType() as GraphQLObjectType).getFields());
    for (const name of [
      'previewCharges',
      'generateCharges',
      'createImportUpload',
      'validateImport',
      'confirmImport',
      'approveAllocations',
      'reverseAllocation',
      'assignException',
      'resolveException',
      'analyzeException',
      'closePeriod',
      'reopenPeriod',
    ]) {
      expect(mutations, `mutation ${name} is missing`).toContain(name);
    }
  });

  it('transports money as minor units and a currency, never as a float', () => {
    expect(sdl).not.toMatch(/amount\s*:\s*Float/i);
    expect(sdl).not.toMatch(/cents\s*:\s*Float/i);
    expect(sdl).toContain('cents: SafeInt!');
  });

  it('requires an idempotency key on every mutation that moves money', () => {
    for (const inputName of [
      'GenerateChargesInput',
      'CreateCreditInput',
      'ConfirmImportInput',
      'ApproveAllocationsInput',
      'ReverseAllocationInput',
      'ClosePeriodInput',
    ]) {
      const block = sdl.slice(sdl.indexOf(`input ${inputName} {`));
      const body = block.slice(0, block.indexOf('\n}'));
      expect(body, `${inputName} has no idempotencyKey`).toContain('idempotencyKey: String!');
    }
  });

  it('requires an expected version wherever a concurrent edit would matter', () => {
    for (const inputName of [
      'ApproveAllocationsInput',
      'AssignExceptionInput',
      'ResolveExceptionInput',
      'ClosePeriodInput',
      'ReopenPeriodInput',
    ]) {
      const block = sdl.slice(sdl.indexOf(`input ${inputName} {`));
      const body = block.slice(0, block.indexOf('\n}'));
      expect(body, `${inputName} has no expected version`).toMatch(/expected\w*Version/);
    }
  });

  it('describes the suggestion score as a ranking, not a probability', () => {
    const type = schema.getType('MatchSuggestion') as GraphQLObjectType;
    const description = type.getFields().score!.description ?? '';
    expect(description.toLowerCase()).toContain('not a probability');
  });
});

describe('enum parity with the domain package', () => {
  const pairs: Record<string, Record<string, string>> = {
    Role,
    PropertyStatus,
    OccupancyStatus,
    ChargeType,
    ChargeStatus,
    ImportStatus,
    TransactionStatus,
    TransactionDirection,
    TransactionSource,
    MatchStrategy,
    SuggestionStatus,
    AllocationStatus,
    ExceptionCategory,
    ExceptionStatus,
    ExceptionSeverity,
    ExceptionResolution,
    PeriodStatus,
    LedgerAccountCode,
    JournalEventType,
    AssistantRunStatus,
  };

  for (const [name, domainEnum] of Object.entries(pairs)) {
    it(`${name} matches`, () => {
      const type = schema.getType(name);
      expect(type, `enum ${name} is missing from the SDL`).toBeInstanceOf(GraphQLEnumType);
      const sdlValues = (type as GraphQLEnumType)
        .getValues()
        .map((value) => value.name)
        .sort();
      expect(sdlValues).toEqual(Object.values(domainEnum).sort());
    });
  }
});

describe('SafeInt', () => {
  it('accepts exact integers', () => {
    expect(SafeIntScalar.parseValue(1234)).toBe(1234);
    expect(SafeIntScalar.serialize(-1234)).toBe(-1234);
    expect(SafeIntScalar.serialize(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('accepts a BigInt that fits, because money columns arrive as BigInt', () => {
    expect(SafeIntScalar.serialize(123456n)).toBe(123456);
  });

  it('refuses anything it cannot represent exactly', () => {
    expect(() => SafeIntScalar.parseValue(1.5)).toThrow(GraphQLError);
    expect(() => SafeIntScalar.parseValue('1234')).toThrow(GraphQLError);
    expect(() => SafeIntScalar.serialize(Number.MAX_SAFE_INTEGER + 2)).toThrow(GraphQLError);
    expect(() => SafeIntScalar.serialize(2n ** 60n)).toThrow(GraphQLError);
  });
});

describe('Date and DateTime are not interchangeable', () => {
  it('Date serializes a UTC-midnight column without shifting the day', () => {
    expect(DateScalar.serialize(new Date('2026-03-15T00:00:00.000Z'))).toBe('2026-03-15');
    expect(DateScalar.serialize('2026-03-15')).toBe('2026-03-15');
  });

  it('Date refuses a timestamp string and an impossible date', () => {
    expect(() => DateScalar.parseValue('2026-03-15T10:00:00Z')).toThrow(GraphQLError);
    expect(() => DateScalar.parseValue('2026-02-30')).toThrow(GraphQLError);
    expect(() => DateScalar.parseValue('15/03/2026')).toThrow(GraphQLError);
  });

  it('DateTime normalises to ISO UTC', () => {
    expect(DateTimeScalar.serialize(new Date('2026-03-15T10:00:00.000Z'))).toBe(
      '2026-03-15T10:00:00.000Z',
    );
    expect(DateTimeScalar.parseValue('2026-03-15T10:00:00+02:00')).toBe('2026-03-15T08:00:00.000Z');
  });

  it('DateTime refuses nonsense', () => {
    expect(() => DateTimeScalar.parseValue('not a date')).toThrow(GraphQLError);
    expect(() => DateTimeScalar.serialize(new Date('nope'))).toThrow(GraphQLError);
  });
});

describe('Period', () => {
  it('accepts YYYY-MM only', () => {
    expect(PeriodScalar.parseValue('2026-03')).toBe('2026-03');
    expect(() => PeriodScalar.parseValue('2026-13')).toThrow(GraphQLError);
    expect(() => PeriodScalar.parseValue('2026-03-01')).toThrow(GraphQLError);
    expect(() => PeriodScalar.parseValue('March 2026')).toThrow(GraphQLError);
  });
});

describe('JSON', () => {
  it('stringifies BigInt rather than throwing on it', () => {
    expect(JSONScalar.serialize({ cents: 1234n })).toEqual({ cents: '1234' });
  });

  it('passes ordinary structures through', () => {
    const value = { a: 1, b: [1, 2], c: { d: true } };
    expect(JSONScalar.serialize(value)).toEqual(value);
  });
});

describe('page size clamping', () => {
  it('defaults, floors and caps', () => {
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(null)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(-5)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(10)).toBe(10);
    expect(clampPageSize(10_000)).toBe(MAX_PAGE_SIZE);
  });
});
