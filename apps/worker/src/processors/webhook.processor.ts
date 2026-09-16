/**
 * Provider webhook processing.
 *
 * The HTTP endpoint verifies the signature and stores the delivery, then
 * returns immediately. This processor applies it.
 *
 * Unlike the import and sync jobs, this one *does* claim the event in
 * `ProcessedEvent`. The difference is that applying a webhook is a single
 * transaction with no natural key of its own: "apply this reversal" is decided
 * from an event id rather than from a row the database can make unique. The
 * claim and the side effect commit together, so a redelivery finds the claim
 * and does nothing, while a failure rolls both back and allows a real retry.
 */

import { Inject, Injectable } from '@nestjs/common';
import { isDomainError, systemContext } from '@rentwell/domain';
import { claimProcessedEvent, type PrismaTransaction } from '@rentwell/database';
import type { Logger } from '@rentwell/observability';
import { PrismaService, TransactionsService } from '@rentwell/api/modules';
import { WORKER_LOGGER } from '../tokens';

const CONSUMER = 'webhook-processor';

interface PendingWebhook {
  id: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  connection: { organizationId: string; provider: string };
}

@Injectable()
export class WebhookProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
    @Inject(WORKER_LOGGER) private readonly logger: Logger,
  ) {}

  /** Applies every stored delivery that has not been processed yet. */
  async processPending(limit = 50): Promise<number> {
    const pending = await this.prisma.client.providerWebhookEvent.findMany({
      where: { processedAt: null },
      include: { connection: { select: { organizationId: true, provider: true } } },
      orderBy: { receivedAt: 'asc' },
      take: limit,
    });

    let applied = 0;
    for (const event of pending) {
      try {
        const handled = await this.applyOne(event as PendingWebhook);
        if (handled) applied += 1;
      } catch (error) {
        await this.prisma.client.providerWebhookEvent
          .update({
            where: { id: event.id },
            data: {
              errorMessage:
                error instanceof Error ? error.message.slice(0, 500) : 'Unknown webhook failure',
            },
          })
          .catch(() => undefined);
        this.logger.error({ err: error, eventId: event.eventId }, 'Webhook processing failed');
      }
    }
    return applied;
  }

  private async applyOne(event: PendingWebhook): Promise<boolean> {
    const access = systemContext(event.connection.organizationId);
    const payload = (event.payload ?? {}) as { transaction?: Record<string, unknown> };
    const transaction = payload.transaction ?? {};

    try {
      return await this.prisma.run(async (tx) => {
        const claimed = await claimProcessedEvent(tx, CONSUMER, event.eventId);
        if (!claimed) {
          await tx.providerWebhookEvent.update({
            where: { id: event.id },
            data: { processedAt: new Date() },
          });
          return false;
        }

        if (event.eventType === 'transaction.reversed') {
          await this.applyReversal(tx, access, event, transaction);
        }

        await tx.providerWebhookEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date(), errorMessage: null },
        });
        return true;
      });
    } catch (error) {
      // A reversal into a closed period is a controller's decision, not
      // something a worker should force. It is left unprocessed and surfaced.
      if (isDomainError(error) && error.code === 'PERIOD_CLOSED') {
        this.logger.warn({ eventId: event.eventId }, 'Webhook reversal targets a closed period');
        return false;
      }
      throw error;
    }
  }

  private async applyReversal(
    tx: PrismaTransaction,
    access: ReturnType<typeof systemContext>,
    event: PendingWebhook,
    transaction: Record<string, unknown>,
  ): Promise<void> {
    const reverses = transaction.reversesExternalId;
    if (typeof reverses !== 'string') {
      this.logger.warn({ eventId: event.eventId }, 'Reversal webhook names no target payment');
      return;
    }

    const target = await tx.bankTransaction.findFirst({
      where: {
        organizationId: access.organizationId,
        providerKey: event.connection.provider,
        externalId: reverses,
      },
      select: { id: true },
    });

    if (!target) {
      this.logger.error(
        { eventId: event.eventId, reverses },
        'Webhook reversed a payment Rentwell has never received',
      );
      return;
    }

    await this.transactions.applyProviderReversal(tx, access, {
      transactionId: target.id,
      reason: `Provider webhook ${event.eventId}`,
      correlationId: null,
      actorSystem: CONSUMER,
    });
  }
}
