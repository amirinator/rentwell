/**
 * Transactional outbox.
 *
 * A business change and the event announcing it are written in one database
 * transaction. If the transaction commits, the event exists; if it rolls back,
 * neither exists. There is no window in which a committed allocation has no
 * event, and none in which an event describes a change that never happened.
 *
 * A separate dispatcher polls PENDING rows and hands them to the queue. Because
 * the dispatcher can crash between enqueueing and marking a row dispatched,
 * delivery is at-least-once, and every consumer deduplicates on `ProcessedEvent`.
 */

import type { OutboxEventDraft } from '@rentwell/domain';
import { processedEventKey } from '@rentwell/domain';
import { isUniqueViolation, toJson, type PrismaTransaction } from './client';

export interface EnqueuedEvent {
  readonly id: string;
  readonly eventType: string;
}

/** Appends one event. Must run inside the transaction making the change. */
export async function enqueueOutboxEvent(
  tx: PrismaTransaction,
  draft: OutboxEventDraft,
): Promise<EnqueuedEvent> {
  const row = await tx.outboxEvent.create({
    data: {
      organizationId: draft.organizationId,
      eventType: draft.eventType,
      partitionKey: draft.partitionKey,
      payload: toJson(draft.payload),
      correlationId: draft.correlationId,
    },
    select: { id: true, eventType: true },
  });
  return row;
}

export async function enqueueOutboxEvents(
  tx: PrismaTransaction,
  drafts: readonly OutboxEventDraft[],
): Promise<EnqueuedEvent[]> {
  const created: EnqueuedEvent[] = [];
  for (const draft of drafts) created.push(await enqueueOutboxEvent(tx, draft));
  return created;
}

export interface ClaimedOutboxEvent {
  id: string;
  organizationId: string;
  eventType: string;
  partitionKey: string;
  payload: unknown;
  attempts: number;
  correlationId: string | null;
  createdAt: Date;
}

/**
 * Claims a batch of due events for dispatch.
 *
 * `FOR UPDATE SKIP LOCKED` lets several dispatcher instances run without
 * handing the same row to two of them, and without one slow row blocking the
 * others. Ordering by `createdAt, id` keeps events for one partition key in
 * insertion order within a batch.
 */
export async function claimOutboxBatch(
  tx: PrismaTransaction,
  batchSize: number,
  now: Date = new Date(),
): Promise<ClaimedOutboxEvent[]> {
  return tx.$queryRaw<ClaimedOutboxEvent[]>`
    SELECT "id", "organizationId", "eventType", "partitionKey", "payload",
           "attempts", "correlationId", "createdAt"
    FROM "outbox_events"
    WHERE "status" IN ('PENDING', 'FAILED')
      AND "availableAt" <= ${now}
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT ${batchSize}
    FOR UPDATE SKIP LOCKED
  `;
}

export async function markOutboxDispatched(
  tx: PrismaTransaction,
  eventIds: readonly string[],
  now: Date = new Date(),
): Promise<number> {
  if (eventIds.length === 0) return 0;
  const result = await tx.outboxEvent.updateMany({
    where: { id: { in: [...eventIds] } },
    data: { status: 'DISPATCHED', dispatchedAt: now, lastError: null },
  });
  return result.count;
}

/**
 * Records a dispatch failure and schedules the next attempt with exponential
 * backoff, moving the row to DEAD_LETTER once attempts are exhausted so an
 * operator sees it instead of it retrying forever.
 */
export async function markOutboxFailed(
  tx: PrismaTransaction,
  eventId: string,
  attempts: number,
  maxAttempts: number,
  error: string,
  now: Date = new Date(),
): Promise<void> {
  const nextAttempt = attempts + 1;
  const exhausted = nextAttempt >= maxAttempts;
  const backoffMs = Math.min(60_000, 500 * 2 ** Math.min(attempts, 7));

  await tx.outboxEvent.update({
    where: { id: eventId },
    data: {
      status: exhausted ? 'DEAD_LETTER' : 'FAILED',
      attempts: nextAttempt,
      lastError: error.slice(0, 2000),
      availableAt: exhausted ? now : new Date(now.getTime() + backoffMs),
    },
  });
}

/** Undispatched event count, used by the close checklist and by monitoring. */
export async function pendingOutboxCount(
  tx: PrismaTransaction,
  organizationId: string,
): Promise<number> {
  return tx.outboxEvent.count({
    where: { organizationId, status: { in: ['PENDING', 'FAILED'] } },
  });
}

/** Age of the oldest undispatched event, in seconds. Zero when the queue is clear. */
export async function outboxLagSeconds(tx: PrismaTransaction): Promise<number> {
  const rows = await tx.$queryRaw<{ lag: number | null }[]>`
    SELECT EXTRACT(EPOCH FROM (NOW() - MIN("createdAt")))::double precision AS lag
    FROM "outbox_events"
    WHERE "status" IN ('PENDING', 'FAILED')
  `;
  return Math.max(0, Math.trunc(rows[0]?.lag ?? 0));
}

/**
 * Marks an event as handled by one consumer.
 *
 * Returns false when this consumer has already processed the event, which is
 * the caller's signal to skip its side effect entirely. Must be called inside
 * the same transaction as that side effect, or the guarantee is lost.
 */
export async function claimProcessedEvent(
  tx: PrismaTransaction,
  consumer: string,
  eventId: string,
): Promise<boolean> {
  try {
    await tx.processedEvent.create({ data: { consumer, eventId } });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export { processedEventKey };
