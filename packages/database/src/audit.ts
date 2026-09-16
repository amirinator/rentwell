/**
 * Audit event writing and idempotency records.
 *
 * Audit rows are only ever inserted. Nothing in this package, the API or the
 * workers updates or deletes one, which is the append-only guarantee the
 * documentation claims — an application-level property, not a cryptographic
 * one. Anyone with direct database access can still change the table.
 */

import { createHash } from 'node:crypto';
import { DomainError, type AuditEventDraft } from '@rentwell/domain';
import { isUniqueViolation, toJson, type PrismaTransaction } from './client';

/** Keys whose values are replaced with a placeholder before storage. */
const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'secret',
  'token',
  'csrftoken',
  'apikey',
  'authorization',
  'cookie',
  'sessionid',
]);

/**
 * Removes anything secret from audit metadata, recursively. Cheap insurance:
 * audit metadata is assembled in many call sites, and one careless spread of a
 * request body should not put a credential in a permanent record.
 */
export function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth limit]';
  if (value === null || value === undefined) return null;
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redactMetadata(item, depth + 1));

  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = REDACTED_KEYS.has(key.toLowerCase())
        ? '[redacted]'
        : redactMetadata(item, depth + 1);
    }
    return result;
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}...`;
  return value;
}

export async function recordAuditEvent(
  tx: PrismaTransaction,
  draft: AuditEventDraft,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      organizationId: draft.organizationId,
      propertyId: draft.propertyId,
      actorUserId: draft.actorUserId,
      actorSystem: draft.actorSystem,
      action: draft.action,
      entityType: draft.entityType,
      entityId: draft.entityId,
      metadata: toJson(redactMetadata(draft.metadata)),
      correlationId: draft.correlationId,
      occurredAt: draft.occurredAt,
    },
  });
}

export async function recordAuditEvents(
  tx: PrismaTransaction,
  drafts: readonly AuditEventDraft[],
): Promise<void> {
  for (const draft of drafts) await recordAuditEvent(tx, draft);
}

// --------------------------------------------------------------------------
// Idempotency
// --------------------------------------------------------------------------

/**
 * Canonical hash of a mutation's input.
 *
 * Object keys are sorted so that two structurally identical inputs hash the
 * same regardless of property order, and BigInt is stringified so money values
 * survive serialisation.
 */
export function hashRequestInput(input: unknown): string {
  return createHash('sha256').update(canonicalize(input)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return `"${value.toISOString()}"`;
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
}

export type IdempotencyOutcome<T> =
  /** First caller. Proceed with the work and call `complete`. */
  | { kind: 'PROCEED'; recordId: string }
  /** Same key and same input, already finished. Replay the stored result. */
  | { kind: 'REPLAY'; response: T }
  /** Same key, work still running elsewhere. */
  | { kind: 'IN_FLIGHT' };

/** How long an idempotency record stays claimable before it can be reused. */
export const IDEMPOTENCY_TTL_HOURS = 24;

/**
 * Claims an idempotency key for one operation.
 *
 * Reusing a key with different input is rejected outright rather than replaying
 * the earlier result, because doing otherwise would silently discard the second
 * request's intent.
 */
export async function claimIdempotencyKey<T>(
  tx: PrismaTransaction,
  params: {
    organizationId: string;
    operation: string;
    key: string;
    input: unknown;
    now?: Date;
  },
): Promise<IdempotencyOutcome<T>> {
  const now = params.now ?? new Date();
  const requestHash = hashRequestInput(params.input);
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_HOURS * 3_600_000);

  try {
    const created = await tx.idempotencyRecord.create({
      data: {
        organizationId: params.organizationId,
        operation: params.operation,
        key: params.key,
        requestHash,
        status: 'IN_PROGRESS',
        expiresAt,
      },
      select: { id: true },
    });
    return { kind: 'PROCEED', recordId: created.id };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  const existing = await tx.idempotencyRecord.findUnique({
    where: {
      organizationId_operation_key: {
        organizationId: params.organizationId,
        operation: params.operation,
        key: params.key,
      },
    },
  });

  if (!existing) {
    // The row vanished between the insert conflict and this read, which means
    // a concurrent expiry sweep removed it. Treat it as contention.
    return { kind: 'IN_FLIGHT' };
  }

  if (existing.requestHash !== requestHash) {
    throw new DomainError(
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used for a different request. Use a new key.',
      { details: { operation: params.operation, key: params.key } },
    );
  }

  if (existing.status === 'COMPLETED') {
    return { kind: 'REPLAY', response: existing.responseBody as T };
  }

  return { kind: 'IN_FLIGHT' };
}

export async function completeIdempotencyKey(
  tx: PrismaTransaction,
  recordId: string,
  response: unknown,
  now: Date = new Date(),
): Promise<void> {
  await tx.idempotencyRecord.update({
    where: { id: recordId },
    data: {
      status: 'COMPLETED',
      responseBody: toJson(response),
      completedAt: now,
    },
  });
}

/** Removes expired records. Run periodically by the worker's maintenance job. */
export async function purgeExpiredIdempotencyRecords(
  tx: PrismaTransaction,
  now: Date = new Date(),
): Promise<number> {
  const result = await tx.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } });
  return result.count;
}
