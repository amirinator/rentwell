/**
 * Periodic housekeeping.
 *
 * Deliberately small: expiring sessions and idempotency records, sampling queue
 * depth for the dashboard's processing panel, and draining stored webhook
 * deliveries. Nothing here changes a financial record.
 */

import { Inject, Injectable } from '@nestjs/common';
import { purgeExpiredIdempotencyRecords } from '@rentwell/database';
import { getMetrics, type Logger } from '@rentwell/observability';
import { PrismaService } from '@rentwell/api/modules';
import { QUEUES, WORKER_LOGGER } from '../tokens';
import type { MaintenanceJobData, QueueSet } from '../queues';
import { WebhookProcessor } from './webhook.processor';

@Injectable()
export class MaintenanceProcessor {
  /** Last observed depth per queue, so the counter can report a delta. */
  private readonly lastDepth = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookProcessor,
    @Inject(QUEUES) private readonly queues: QueueSet,
    @Inject(WORKER_LOGGER) private readonly logger: Logger,
  ) {}

  async process(data: MaintenanceJobData): Promise<void> {
    switch (data.task) {
      case 'purge-sessions': {
        const removed = await this.prisma.client.session.deleteMany({
          where: {
            OR: [
              { expiresAt: { lt: new Date() } },
              // A revoked session is kept for a week so an investigation can
              // still see that it existed.
              { revokedAt: { lt: new Date(Date.now() - 7 * 86_400_000) } },
            ],
          },
        });
        this.logger.info({ removed: removed.count }, 'Purged expired sessions');
        return;
      }

      case 'purge-idempotency': {
        const removed = await this.prisma.run((tx) => purgeExpiredIdempotencyRecords(tx));
        this.logger.info({ removed }, 'Purged expired idempotency records');
        return;
      }

      case 'sample-queue-depth': {
        const applied = await this.webhooks.processPending();
        if (applied > 0) this.logger.info({ applied }, 'Applied stored webhook deliveries');

        const metrics = getMetrics();
        const queues = [
          ['imports', this.queues.imports],
          ['provider-sync', this.queues.providerSync],
          ['suggestions', this.queues.suggestions],
        ] as const;

        for (const [name, queue] of queues) {
          const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
          const depth = (counts.waiting ?? 0) + (counts.delayed ?? 0);

          // An UpDownCounter records a change, not a level, so the observed
          // depth is reported as the difference from the previous sample.
          const previous = this.lastDepth.get(name) ?? 0;
          metrics.queueDepth.add(depth - previous, { queue: name });
          this.lastDepth.set(name, depth);

          if ((counts.failed ?? 0) > 0) {
            this.logger.warn({ queue: name, failed: counts.failed }, 'Queue has failed jobs');
          }
        }
        return;
      }
    }
  }
}
