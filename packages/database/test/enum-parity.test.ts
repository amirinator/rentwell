/**
 * Enum parity between the Prisma schema and the domain package.
 *
 * `@rentwell/domain` deliberately does not import the generated Prisma client,
 * so the two definitions of every enumeration are written twice. This test is
 * what stops them drifting: it parses schema.prisma directly (no generated
 * client required, so it runs on a clean checkout) and compares each enum with
 * its domain counterpart, in both directions.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AllocationStatus,
  AssistantRunStatus,
  ChargeStatus,
  ChargeType,
  ExceptionCategory,
  ExceptionResolution,
  ExceptionSeverity,
  ExceptionStatus,
  JournalEventType,
  LeaseStatus,
  LedgerAccountCode,
  MatchStrategy,
  MembershipStatus,
  NormalBalance,
  OccupancyStatus,
  OutboxStatus,
  PeriodStatus,
  PropertyStatus,
  ProrationMethod,
  Role,
  ScheduleFrequency,
  SuggestionStatus,
  TenantKind,
  TransactionDirection,
  TransactionSource,
  TransactionStatus,
  ImportStatus,
} from '@rentwell/domain';

const SCHEMA_PATH = join(__dirname, '..', 'prisma', 'schema.prisma');

/** Parses `enum Name { A B C }` blocks out of the Prisma schema. */
function parsePrismaEnums(source: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const pattern = /^enum\s+(\w+)\s*\{([^}]*)\}/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    const name = match[1]!;
    const values = match[2]!
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line.length > 0 && /^[A-Z][A-Z0-9_]*$/.test(line));
    result.set(name, values.sort());
  }

  return result;
}

const prismaEnums = parsePrismaEnums(readFileSync(SCHEMA_PATH, 'utf8'));

const PAIRS: Record<string, Record<string, string>> = {
  Role,
  MembershipStatus,
  PropertyStatus,
  OccupancyStatus,
  TenantKind,
  LeaseStatus,
  ChargeType,
  ChargeStatus,
  ScheduleFrequency,
  ProrationMethod,
  ImportStatus,
  TransactionSource,
  TransactionStatus,
  TransactionDirection,
  SuggestionStatus,
  MatchStrategy,
  AllocationStatus,
  ExceptionCategory,
  ExceptionStatus,
  ExceptionSeverity,
  ExceptionResolution,
  LedgerAccountCode,
  NormalBalance,
  JournalEventType,
  PeriodStatus,
  OutboxStatus,
  AssistantRunStatus,
};

describe('Prisma and domain enumerations agree', () => {
  it('parses every enum out of schema.prisma', () => {
    expect(prismaEnums.size).toBeGreaterThanOrEqual(Object.keys(PAIRS).length);
  });

  for (const [name, domainEnum] of Object.entries(PAIRS)) {
    it(`${name} has identical members on both sides`, () => {
      const prismaValues = prismaEnums.get(name);
      expect(prismaValues, `enum ${name} is missing from schema.prisma`).toBeDefined();
      expect(prismaValues).toEqual(Object.values(domainEnum).sort());
    });

    it(`${name} maps every key to itself in the domain package`, () => {
      // Guards against a typo like `POSTED: 'PSOTED'`, which the parity check
      // above would not catch on its own.
      for (const [key, value] of Object.entries(domainEnum)) {
        expect(value).toBe(key);
      }
    });
  }
});

describe('schema conventions', () => {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');

  it('stores every money column as BigInt minor units', () => {
    const moneyColumns = schema
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\w*[Cc]ents\s+/.test(line));

    expect(moneyColumns.length).toBeGreaterThan(10);
    for (const line of moneyColumns) {
      expect(line, `money column is not BigInt: ${line}`).toMatch(/\bBigInt\b/);
    }
  });

  it('never stores money as Float or Decimal', () => {
    expect(schema).not.toMatch(/\w*[Cc]ents\s+Float/);
    expect(schema).not.toMatch(/\w*[Cc]ents\s+Decimal/);
    expect(schema).not.toMatch(/amount\s+Float/i);
  });

  it('stores every timestamp with a timezone', () => {
    const timestampColumns = schema
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /\bDateTime\b/.test(line) && !/@db\.Date\b/.test(line));

    for (const line of timestampColumns) {
      expect(line, `timestamp column is not Timestamptz: ${line}`).toMatch(/@db\.Timestamptz\(6\)/);
    }
  });

  it('stores accounting periods as a fixed-width YYYY-MM string', () => {
    const periodColumns = schema
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^period\s+String/.test(line));

    expect(periodColumns.length).toBeGreaterThan(5);
    for (const line of periodColumns) {
      expect(line).toMatch(/@db\.VarChar\(7\)/);
    }
  });

  it('keeps the post-once and record-deduplication indexes', () => {
    // These four unique indexes are the ones that make retries safe. Losing any
    // of them would let a redelivered event double a financial effect.
    expect(schema).toContain('@@unique([organizationId, postingEventId])');
    expect(schema).toContain('@@unique([organizationId, generationKey])');
    expect(schema).toContain('@@unique([bankAccountId, providerKey, externalId])');
    expect(schema).toContain('@@unique([consumer, eventId])');
    expect(schema).toContain('@@unique([organizationId, operation, key])');
    expect(schema).toContain('@@unique([connectionId, eventId])');
    expect(schema).toContain('@@unique([propertyId, period])');
  });

  it('gives conflict-sensitive records a version column', () => {
    for (const model of ['model Charge {', 'model BankTransaction {', 'model AccountingPeriod {']) {
      const start = schema.indexOf(model);
      expect(start, `${model} not found`).toBeGreaterThan(-1);
      const block = schema.slice(start, schema.indexOf('\n}', start));
      expect(block, `${model} has no version column`).toMatch(/version\s+Int\s+@default\(1\)/);
    }
  });
});
