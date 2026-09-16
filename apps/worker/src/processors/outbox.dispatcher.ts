/**
 * Outbox dispatcher.
 *
 * Polls `outbox_events` and publishes each one to the queue that handles it.
 *
 * Delivery is at-least-once, and deliberately so. The dispatcher can crash
 * between enqueueing a job and marking the row dispatched, which means that row
 * is published again on the next poll. The alternative — marking first — would
 * lose an event on the same crash, and a lost event is far worse than a
 * repeated one when every consumer is idempotent.
 *
 * Rows are claimed with `FOR UPDATE SKIP LOCKED`, so several dispatcher
 * instances can run without handing the same event to two of them and without
 * one slow row blocking the rest.
 */

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { OutboxEventType } from '@rentwell/domain';
import {
  claimOutboxBatch,
  markOutboxDispatched,
  markOutboxFailed,
  outboxLagSeconds,
  type ClaimedOutboxEvent,
} from '@rentwell/database';
import { getMetrics, type Logger } from '@rentwell/observability';
import { PrismaService } from '@rentwell/api/modules';
import { QUEUES, WORKER_CONFIG, WORKER_LOGGER } from '../tokens';
import type { WorkerConfig } from '../config';
import { deterministicJobId, type QueueSet } from '../queues';

@Injectable()
export class OutboxDispatcher implements OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(QUEUES) private readonly queues: QueueSet,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(WORKER_LOGGER) private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.outbox.pollIntervalMs);
    // Unref so the interval alone does not keep the process alive.
    this.timer.unref();
    this.logger.info(
      { intervalMs: this.config.outbox.pollIntervalMs },
      'Outbox dispatcher started',
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let an in-flight tick finish so a claimed batch is not abandoned.
    for (let i = 0; i < 50 && this.running; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * One polling pass. Re-entrancy is prevented by the `running` flag: a slow
   * batch must not have a second timer tick claiming rows underneath it.
   */
  async tick(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;

    try {
      const dispatched = await this.prisma.run(async (tx) => {
        const events = await claimOutboxBatch(tx, this.config.outbox.batchSize);
        if (events.length === 0) return 0;

        const succeeded: string[] = [];

        for (const event of events) {
          try {
            await this.publish(event);
            succeeded.push(event.id);
          } catch (error) {
            await markOutboxFailed(
              tx,
              event.id,
              event.attempts,
              this.config.outbox.maxAttempts,
              error instanceof Error ? error.message : 'Unknown dispatch failure',
            );
            this.logger.warn(
              { err: error, eventId: event.id, eventType: event.eventType },
              'Could not dispatch an outbox event',
            );
          }
        }

        await markOutboxDispatched(tx, succeeded);
        return succeeded.length;
      });

      if (dispatched > 0) {
        getMetrics().outboxDispatched.add(dispatched);
      }

      await this.sampleLag();
      return dispatched;
    } catch (error) {
      this.logger.error({ err: error }, 'Outbox dispatch pass failed');
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Routes one event to its queue.
   *
   * The job id is derived from the event id, so BullMQ collapses a repeated
   * delivery while the job is still waiting. That is an optimisation; the
   * correctness guarantee is that every consumer is idempotent.
   */
  private async publish(event: ClaimedOutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    switch (event.eventType) {
      case OutboxEventType.IMPORT_CONFIRMED: {
        await this.queues.imports.add(
          'process-import',
          {
            importId: String(payload.importId),
            organizationId: event.organizationId,
            propertyId: String(payload.propertyId),
            bankAccountId: String(payload.bankAccountId),
            correlationId: event.correlationId,
            outboxEventId: event.id,
          },
          { jobId: deterministicJobId('import', event.id) },
        );
        return;
      }

      case OutboxEventType.PROVIDER_SYNC_REQUESTED: {
        await this.queues.providerSync.add(
          'sync-provider',
          {
            connectionId: String(payload.connectionId),
            organizationId: event.organizationId,
            correlationId: event.correlationId,
            outboxEventId: event.id,
          },
          { jobId: deterministicJobId('sync', event.id) },
        );
        return;
      }

      case OutboxEventType.TRANSACTION_INGESTED:
      case OutboxEventType.ALLOCATION_REVERSED:
      case OutboxEventType.TRANSACTION_REVERSED: {
        // Balances moved, so any stored suggestion for this payment may now be
        // stale. Regenerating is cheap and keeps the workbench honest.
        const transactionId = payload.transactionId;
        if (typeof transactionId !== 'string') return;
        await this.queues.suggestions.add(
          'generate-suggestions',
          {
            transactionId,
            organizationId: event.organizationId,
            correlationId: event.correlationId,
            outboxEventId: event.id,
          },
          { jobId: deterministicJobId('suggest', event.id) },
        );
        return;
      }

      case OutboxEventType.CHARGES_GENERATED:
      case OutboxEventType.ALLOCATION_APPROVED:
      case OutboxEventType.EXCEPTION_OPENED:
      case OutboxEventType.IMPORT_BATCH_READY:
      case OutboxEventType.PERIOD_CLOSED:
        // Recorded for the audit trail and for downstream consumers a later
        // version may add. Nothing subscribes to them today, and saying so
        // here is better than a silent default branch.
        return;

      default:
        this.logger.warn({ eventType: event.eventType }, 'No consumer for this outbox event type');
    }
  }

  /** Records outbox lag, which is the signal that dispatch has fallen behind. */
  private async sampleLag(): Promise<void> {
    const lag = await outboxLagSeconds(this.prisma.client);
    getMetrics().outboxLag.record(lag);
    if (lag > this.config.outbox.lagWarnSeconds) {
      this.logger.warn({ lagSeconds: lag }, 'Outbox dispatch is falling behind');
    }
  }
}
