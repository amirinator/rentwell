/**
 * Worker bootstrap.
 *
 * Starts one BullMQ worker per queue, the outbox dispatcher, and the repeating
 * maintenance job, then waits for a signal.
 *
 * Shutdown is the part worth reading. On SIGTERM the process:
 *
 *  1. stops the outbox dispatcher, so no new work is published;
 *  2. closes each BullMQ worker, which stops accepting jobs and waits for the
 *     ones in flight;
 *  3. closes the queues, Redis and the database pool.
 *
 * A job interrupted by a hard kill is not lost: BullMQ re-delivers it after its
 * lock expires, and every processor is built to be re-delivered safely. The
 * grace period exists so that in the normal case a job finishes rather than
 * being re-delivered at all.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Worker } from 'bullmq';
import { getMetrics, startTracing, type TracingHandle } from '@rentwell/observability';
import { PrismaService } from '@rentwell/api/modules';
import { WorkerModule } from './worker.module';
import { queues, redisConnection, workerConfig, workerLogger } from './worker-core.module';
import { QUEUE_NAMES, createWorker } from './queues';
import type {
  ImportJobData,
  MaintenanceJobData,
  ProviderSyncJobData,
  SuggestionJobData,
} from './queues';
import { ImportProcessor } from './processors/import.processor';
import { ProviderSyncProcessor } from './processors/provider-sync.processor';
import { SuggestionProcessor } from './processors/suggestion.processor';
import { MaintenanceProcessor } from './processors/maintenance.processor';
import { OutboxDispatcher } from './processors/outbox.dispatcher';

async function bootstrap(): Promise<void> {
  const tracing: TracingHandle = await startTracing({
    enabled: workerConfig.otel.enabled,
    serviceName: 'rentwell-worker',
    otlpEndpoint: workerConfig.otel.endpoint,
    environment: workerConfig.env,
  });

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn'],
  });
  app.enableShutdownHooks();

  const imports = app.get(ImportProcessor);
  const providerSync = app.get(ProviderSyncProcessor);
  const suggestions = app.get(SuggestionProcessor);
  const maintenance = app.get(MaintenanceProcessor);
  const dispatcher = app.get(OutboxDispatcher);
  const prisma = app.get(PrismaService);

  const prefix = workerConfig.redis.queuePrefix;
  const concurrency = workerConfig.worker.concurrency;

  const workers: Worker[] = [
    createWorker<ImportJobData>(
      QUEUE_NAMES.IMPORT,
      async (job) => imports.process(job.data),
      redisConnection,
      prefix,
      // Imports hold long transactions, so one at a time per process keeps the
      // connection pool available for everything else.
      1,
    ),
    createWorker<ProviderSyncJobData>(
      QUEUE_NAMES.PROVIDER_SYNC,
      async (job) => providerSync.process(job.data),
      redisConnection,
      prefix,
      1,
    ),
    createWorker<SuggestionJobData>(
      QUEUE_NAMES.SUGGESTIONS,
      async (job) => suggestions.process(job.data),
      redisConnection,
      prefix,
      concurrency,
    ),
    createWorker<MaintenanceJobData>(
      QUEUE_NAMES.MAINTENANCE,
      async (job) => maintenance.process(job.data),
      redisConnection,
      prefix,
      1,
    ),
  ];

  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      getMetrics().workerRetries.add(1, {
        queue: worker.name,
        attempt: String(job?.attemptsMade ?? 0),
      });
      workerLogger.error(
        {
          err: error,
          queue: worker.name,
          jobId: job?.id,
          attempt: job?.attemptsMade,
          // The last attempt is the one an operator needs to see; earlier ones
          // are noise from a retry that may still succeed.
          final: (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1),
        },
        'Job failed',
      );
    });

    worker.on('error', (error) => {
      workerLogger.error({ err: error, queue: worker.name }, 'Worker error');
    });
  }

  // Repeating maintenance. The job id is fixed so restarting the worker does
  // not accumulate duplicate schedules.
  await queues.maintenance.add(
    'sample-queue-depth',
    { task: 'sample-queue-depth' },
    { repeat: { every: 30_000 }, jobId: 'maintenance:sample' },
  );
  await queues.maintenance.add(
    'purge-sessions',
    { task: 'purge-sessions' },
    { repeat: { every: 3_600_000 }, jobId: 'maintenance:sessions' },
  );
  await queues.maintenance.add(
    'purge-idempotency',
    { task: 'purge-idempotency' },
    { repeat: { every: 3_600_000 }, jobId: 'maintenance:idempotency' },
  );

  dispatcher.start();

  workerLogger.info(
    {
      queues: workers.map((worker) => worker.name),
      concurrency,
      bankProvider: workerConfig.bank.provider,
    },
    'Rentwell worker started',
  );

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    workerLogger.info({ signal }, 'Shutting down');

    const deadline = setTimeout(() => {
      workerLogger.error('Graceful shutdown timed out; exiting');
      process.exit(1);
    }, workerConfig.worker.shutdownGraceMs);
    deadline.unref();

    try {
      // Stop publishing before stopping consuming, so nothing is enqueued into
      // a queue that is about to close.
      await dispatcher.onModuleDestroy();
      await Promise.all(workers.map((worker) => worker.close()));
      await queues.close();
      await app.close();
      await prisma.client.$disconnect();
      await redisConnection.quit();
      await tracing.shutdown();
      clearTimeout(deadline);
      workerLogger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      workerLogger.error({ err: error }, 'Shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error: unknown) => {
  workerLogger.error({ err: error }, 'Worker failed to start');
  process.exitCode = 1;
});
