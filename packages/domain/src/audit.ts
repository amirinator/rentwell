/**
 * Audit and outbox event vocabulary.
 *
 * Audit events are append-only through the application's own interfaces: no
 * resolver, service or job updates or deletes one. That is an application-level
 * guarantee, not a cryptographic one — anyone with direct database access can
 * still alter the table, and the documentation says so rather than claiming
 * tamper-proof history.
 */

export const AuditAction = Object.freeze({
  // Access
  USER_SIGNED_IN: 'USER_SIGNED_IN',
  USER_SIGNED_OUT: 'USER_SIGNED_OUT',
  SIGN_IN_FAILED: 'SIGN_IN_FAILED',
  MEMBERSHIP_CHANGED: 'MEMBERSHIP_CHANGED',
  PROPERTY_ASSIGNMENT_CHANGED: 'PROPERTY_ASSIGNMENT_CHANGED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  // Portfolio
  PROPERTY_CREATED: 'PROPERTY_CREATED',
  PROPERTY_UPDATED: 'PROPERTY_UPDATED',
  TENANT_CREATED: 'TENANT_CREATED',
  TENANT_UPDATED: 'TENANT_UPDATED',
  LEASE_CREATED: 'LEASE_CREATED',
  LEASE_AMENDED: 'LEASE_AMENDED',
  // Billing
  CHARGES_PREVIEWED: 'CHARGES_PREVIEWED',
  CHARGES_GENERATED: 'CHARGES_GENERATED',
  CREDIT_ADJUSTMENT_CREATED: 'CREDIT_ADJUSTMENT_CREATED',
  // Ingestion
  IMPORT_CREATED: 'IMPORT_CREATED',
  IMPORT_VALIDATED: 'IMPORT_VALIDATED',
  IMPORT_CONFIRMED: 'IMPORT_CONFIRMED',
  IMPORT_CANCELLED: 'IMPORT_CANCELLED',
  IMPORT_COMPLETED: 'IMPORT_COMPLETED',
  IMPORT_FAILED: 'IMPORT_FAILED',
  IMPORT_FILE_DOWNLOADED: 'IMPORT_FILE_DOWNLOADED',
  PROVIDER_SYNC_REQUESTED: 'PROVIDER_SYNC_REQUESTED',
  PROVIDER_SYNC_COMPLETED: 'PROVIDER_SYNC_COMPLETED',
  PROVIDER_WEBHOOK_RECEIVED: 'PROVIDER_WEBHOOK_RECEIVED',
  // Reconciliation
  SUGGESTIONS_GENERATED: 'SUGGESTIONS_GENERATED',
  ALLOCATIONS_APPROVED: 'ALLOCATIONS_APPROVED',
  ALLOCATION_REVERSED: 'ALLOCATION_REVERSED',
  PAYMENT_REVERSED: 'PAYMENT_REVERSED',
  EXCEPTION_OPENED: 'EXCEPTION_OPENED',
  EXCEPTION_ASSIGNED: 'EXCEPTION_ASSIGNED',
  EXCEPTION_RESOLVED: 'EXCEPTION_RESOLVED',
  EXCEPTION_REOPENED: 'EXCEPTION_REOPENED',
  // Close
  PERIOD_REVIEW_STARTED: 'PERIOD_REVIEW_STARTED',
  PERIOD_CLOSED: 'PERIOD_CLOSED',
  PERIOD_REOPENED: 'PERIOD_REOPENED',
  // Assistant
  ASSISTANT_RUN_STARTED: 'ASSISTANT_RUN_STARTED',
  ASSISTANT_RUN_COMPLETED: 'ASSISTANT_RUN_COMPLETED',
  ASSISTANT_TOOL_DENIED: 'ASSISTANT_TOOL_DENIED',
} as const);
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEventDraft {
  readonly organizationId: string;
  readonly propertyId: string | null;
  readonly actorUserId: string | null;
  /** Set when a background worker acted without a human actor. */
  readonly actorSystem: string | null;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  /** Structured context. Never contains credentials or raw file contents. */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
}

/**
 * Names of events published through the transactional outbox.
 *
 * Consumers must be idempotent: delivery is at-least-once, and the dispatcher
 * retries until a consumer records the event id in ProcessedEvent.
 */
export const OutboxEventType = Object.freeze({
  IMPORT_CONFIRMED: 'import.confirmed',
  IMPORT_BATCH_READY: 'import.batch_ready',
  TRANSACTION_INGESTED: 'transaction.ingested',
  TRANSACTION_REVERSED: 'transaction.reversed',
  CHARGES_GENERATED: 'charges.generated',
  ALLOCATION_APPROVED: 'allocation.approved',
  ALLOCATION_REVERSED: 'allocation.reversed',
  EXCEPTION_OPENED: 'exception.opened',
  PERIOD_CLOSED: 'period.closed',
  PROVIDER_SYNC_REQUESTED: 'provider.sync_requested',
} as const);
export type OutboxEventType = (typeof OutboxEventType)[keyof typeof OutboxEventType];

export interface OutboxEventDraft {
  readonly organizationId: string;
  readonly eventType: OutboxEventType;
  /** Groups events that must be processed in order (usually an aggregate id). */
  readonly partitionKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly correlationId: string | null;
}

/**
 * Deterministic key for deduplicating a consumer's work.
 *
 * A consumer writes this into ProcessedEvent inside the same transaction as its
 * side effect, so a redelivered event finds the row and becomes a no-op.
 */
export function processedEventKey(consumer: string, eventId: string): string {
  return `${consumer}:${eventId}`;
}
