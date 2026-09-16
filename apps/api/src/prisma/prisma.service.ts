/**
 * Prisma lifecycle for the Nest application.
 *
 * The client connects on module init and disconnects on shutdown, so the
 * process does not exit with connections still open and Postgres does not have
 * to reap them. `enableShutdownHooks` is wired in `main.ts` so SIGTERM from a
 * container runtime reaches this.
 */

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  createPrismaClient,
  runInTransaction,
  type PrismaClient,
  type PrismaTransaction,
  type TransactionOptions,
} from '@rentwell/database';
import type { Logger } from '@rentwell/observability';
import { API_CONFIG, type ApiConfig } from '../config/configuration';
import { LOGGER } from '../common/tokens';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.client = createPrismaClient({
      databaseUrl: this.config.databaseUrl,
      slowQueryMs: 500,
      onSlowQuery: ({ query, durationMs }) => {
        this.logger.warn({ durationMs, query: query.slice(0, 500) }, 'Slow database query');
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /** Runs work in a transaction, retrying serialization failures. */
  run<T>(work: (tx: PrismaTransaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
    return runInTransaction(this.client, work, {
      ...options,
      onRetry: (attempt, error) => {
        this.logger.warn({ attempt, err: error }, 'Retrying transaction after a write conflict');
        options?.onRetry?.(attempt, error);
      },
    });
  }

  /** Readiness probe. A cheap round trip that proves the connection works. */
  async healthCheck(): Promise<string> {
    const rows = await this.client.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
    if (rows[0]?.ok !== 1) throw new Error('Unexpected response from the database');
    return 'connected';
  }
}
