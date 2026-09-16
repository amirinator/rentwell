/**
 * Worker configuration.
 *
 * Reuses the API's environment schema so the two processes cannot disagree
 * about a database URL, a bucket name or a provider seed, and adds only the
 * settings that are meaningful to a worker.
 */

import { loadConfig, type ApiConfig } from '@rentwell/api/modules';

export interface WorkerConfig extends Omit<ApiConfig, 'imports'> {
  /** The API's import settings plus the batch size only a worker needs. */
  readonly imports: ApiConfig['imports'] & { readonly batchSize: number };
  readonly worker: {
    readonly concurrency: number;
    /** How long a shutdown waits for in-flight jobs before forcing an exit. */
    readonly shutdownGraceMs: number;
  };
  readonly outbox: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly maxAttempts: number;
    readonly lagWarnSeconds: number;
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const base = loadConfig(env);

  return {
    ...base,
    imports: { ...base.imports, batchSize: positiveInt(env.IMPORT_BATCH_SIZE, 250) },
    worker: {
      concurrency: positiveInt(env.WORKER_CONCURRENCY, 4),
      shutdownGraceMs: positiveInt(env.WORKER_SHUTDOWN_GRACE_MS, 15_000),
    },
    outbox: {
      pollIntervalMs: positiveInt(env.OUTBOX_POLL_INTERVAL_MS, 750),
      batchSize: positiveInt(env.OUTBOX_BATCH_SIZE, 100),
      maxAttempts: positiveInt(env.OUTBOX_MAX_ATTEMPTS, 12),
      lagWarnSeconds: positiveInt(env.OUTBOX_LAG_WARN_SECONDS, 60),
    },
  };
}
