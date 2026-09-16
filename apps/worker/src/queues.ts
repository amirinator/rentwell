/**
 * Queue topology.
 *
 * Redis holds queue state only. Every financial fact lives in PostgreSQL, so
 * losing Redis costs throughput and never costs correctness: the outbox still
 * holds the events, and the dispatcher republishes them.
 *
 * Retry policy is bounded exponential backoff with a jitter-free base, because
 * the failures worth retrying here (a provider timeout, a transient
 * serialization failure) clear in seconds, and the ones that do not are better
 * surfaced to an operator than retried forever.
 */

import { Queue, Worker, type ConnectionOptions, type JobsOptions, type Processor } from 'bullmq';
import IORedis from 'ioredis';

export const QUEUE_NAMES = {
  IMPORT: 'import-processing',
  PROVIDER_SYNC: 'provider-sync',
  SUGGESTIONS: 'suggestion-generation',
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  // Completed jobs are kept briefly so an operator can see what ran; failed
  // ones are kept far longer, because those are the ones worth inspecting.
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 86_400 },
};

export interface ImportJobData {
  readonly importId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly bankAccountId: string;
  readonly correlationId: string | null;
  /** Set when an outbox event drove this job, for consumer deduplication. */
  readonly outboxEventId?: string;
}

export interface ProviderSyncJobData {
  readonly connectionId: string;
  readonly organizationId: string;
  readonly correlationId: string | null;
  readonly outboxEventId?: string;
}

export interface SuggestionJobData {
  readonly transactionId: string;
  readonly organizationId: string;
  readonly correlationId: string | null;
  readonly outboxEventId?: string;
}

export interface MaintenanceJobData {
  readonly task: 'purge-sessions' | 'purge-idempotency' | 'sample-queue-depth';
}

/**
 * Builds the Redis connection BullMQ needs.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ's blocking commands: with
 * a limit, a blocking read that outlives the limit throws and kills the worker.
 */
export function createRedisConnection(url: string): IORedis {
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
}

export interface QueueSet {
  readonly imports: Queue<ImportJobData>;
  readonly providerSync: Queue<ProviderSyncJobData>;
  readonly suggestions: Queue<SuggestionJobData>;
  readonly maintenance: Queue<MaintenanceJobData>;
  close(): Promise<void>;
}

export function createQueues(connection: ConnectionOptions, prefix: string): QueueSet {
  const options = { connection, prefix, defaultJobOptions: DEFAULT_JOB_OPTIONS };

  const imports = new Queue<ImportJobData>(QUEUE_NAMES.IMPORT, options);
  const providerSync = new Queue<ProviderSyncJobData>(QUEUE_NAMES.PROVIDER_SYNC, options);
  const suggestions = new Queue<SuggestionJobData>(QUEUE_NAMES.SUGGESTIONS, options);
  const maintenance = new Queue<MaintenanceJobData>(QUEUE_NAMES.MAINTENANCE, options);

  return {
    imports,
    providerSync,
    suggestions,
    maintenance,
    async close() {
      await Promise.all([
        imports.close(),
        providerSync.close(),
        suggestions.close(),
        maintenance.close(),
      ]);
    },
  };
}

export function createWorker<T>(
  name: QueueName,
  processor: Processor<T>,
  connection: ConnectionOptions,
  prefix: string,
  concurrency: number,
): Worker<T> {
  return new Worker<T>(name, processor, {
    connection,
    prefix,
    concurrency,
    // A job that outlives this is assumed dead and re-delivered. Import batches
    // are resumable, so re-delivery costs a repeated batch, never a duplicate
    // payment.
    lockDuration: 60_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  });
}

/**
 * Deterministic job id.
 *
 * BullMQ deduplicates on job id while a job is waiting or active, so an outbox
 * event dispatched twice in quick succession enqueues once. It is a throughput
 * optimisation, not a correctness guarantee: the guarantee is
 * `ProcessedEvent`, which survives the job leaving the queue.
 */
export function deterministicJobId(prefix: string, key: string): string {
  return `${prefix}:${key}`;
}
