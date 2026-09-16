/**
 * Prisma client construction and transaction helpers.
 */

import { Prisma, PrismaClient } from '../generated/prisma';
import { DomainError } from '@rentwell/domain';

export { Prisma, PrismaClient };

/**
 * The subset of the client available inside an interactive transaction.
 * Services accept this type so the same code runs inside or outside one.
 */
export type PrismaTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Coerces an application value into the type Prisma accepts for a `Json`
 * column. Prisma models JSON input as a recursive union that plain
 * `Record<string, unknown>` does not structurally satisfy, so the conversion is
 * done once here rather than with a scattering of casts at every call site.
 * The value must already be JSON-serialisable; `undefined` becomes `null`.
 */
export function toJson(value: unknown): Prisma.InputJsonValue {
  return (value ?? null) as Prisma.InputJsonValue;
}

/** Reads a `Json` column back as a typed value. The caller states the shape. */
export function fromJson<T>(value: unknown): T {
  return value as T;
}

export interface CreateClientOptions {
  readonly databaseUrl?: string;
  readonly logQueries?: boolean;
  /** Slow-query threshold in milliseconds. Queries above it are logged warn. */
  readonly slowQueryMs?: number;
  readonly onSlowQuery?: (event: { query: string; durationMs: number }) => void;
}

export function createPrismaClient(options: CreateClientOptions = {}): PrismaClient {
  const log: Prisma.LogDefinition[] = [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
  ];
  if (options.logQueries === true || options.onSlowQuery) {
    log.push({ level: 'query', emit: 'event' });
  }

  const client = new PrismaClient({
    log,
    ...(options.databaseUrl ? { datasources: { db: { url: options.databaseUrl } } } : {}),
  });

  if (options.onSlowQuery) {
    const threshold = options.slowQueryMs ?? 500;
    // `as never` narrows the overloaded $on signature, which Prisma types by
    // the literal log level rather than by the array we built above.
    (client.$on as never as (event: 'query', handler: (e: Prisma.QueryEvent) => void) => void)(
      'query',
      (event) => {
        if (event.duration >= threshold) {
          options.onSlowQuery?.({ query: event.query, durationMs: event.duration });
        }
      },
    );
  }

  return client;
}

// --------------------------------------------------------------------------
// Error classification
// --------------------------------------------------------------------------

/** Postgres error codes that mean "retry the whole transaction". */
const RETRYABLE_PG_CODES = new Set(['40001', '40P01']);

export function isUniqueViolation(error: unknown, target?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  if (!target) return true;
  const meta = error.meta as { target?: string[] | string } | undefined;
  const fields = Array.isArray(meta?.target) ? meta!.target : meta?.target ? [meta.target] : [];
  return fields.includes(target);
}

export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

export function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P2034 is Prisma's own write-conflict/deadlock signal.
    if (error.code === 'P2034') return true;
    const meta = error.meta as { code?: string } | undefined;
    if (meta?.code && RETRYABLE_PG_CODES.has(meta.code)) return true;
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return [...RETRYABLE_PG_CODES].some((code) => error.message.includes(code));
  }
  return false;
}

// --------------------------------------------------------------------------
// Transactions
// --------------------------------------------------------------------------

export interface TransactionOptions {
  /** Attempts including the first. Serialization failures are retried. */
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly maxWaitMs?: number;
  readonly isolationLevel?: Prisma.TransactionIsolationLevel;
  readonly onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * Runs `work` in an interactive transaction, retrying serialization failures
 * and deadlocks with a short backoff.
 *
 * Financial work uses the default READ COMMITTED level plus explicit row locks
 * and period advisory locks rather than SERIALIZABLE, because the contended
 * rows are known ahead of time and locking them in a fixed order is cheaper and
 * more predictable than retrying under contention.
 */
export async function runInTransaction<T>(
  client: PrismaClient,
  work: (tx: PrismaTransaction) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await client.$transaction((tx) => work(tx), {
        timeout: options.timeoutMs ?? 15_000,
        maxWait: options.maxWaitMs ?? 5_000,
        ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
      });
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableTransactionError(error)) throw error;
      options.onRetry?.(attempt, error);
      // Jittered backoff: two conflicting writers should not re-collide.
      const delay = 25 * 2 ** (attempt - 1) + Math.floor(Math.random() * 25);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new DomainError(
    'CONFLICT',
    'Transaction could not complete because of repeated write conflicts',
    {
      retryable: true,
      cause: lastError,
    },
  );
}
