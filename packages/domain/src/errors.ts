/**
 * Domain errors.
 *
 * Every failure the domain can produce is one of these. The API layer maps the
 * `code` onto a stable GraphQL error code, so callers can branch on a value
 * that does not change when a message is reworded. `details` carries structured
 * context (offending ids, balances, versions) and must never contain secrets.
 */

export type DomainErrorCode =
  // Authorization
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'ORGANIZATION_MISMATCH'
  | 'PROPERTY_NOT_ASSIGNED'
  // Validation
  | 'VALIDATION_FAILED'
  | 'INVALID_MONEY'
  | 'INVALID_DATE'
  | 'CURRENCY_MISMATCH'
  | 'UNSUPPORTED_CURRENCY'
  // State
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'STALE_RECORD'
  | 'PERIOD_CLOSED'
  | 'PERIOD_NOT_OPEN'
  | 'PERIOD_STATE_INVALID'
  | 'DUPLICATE_EVENT'
  | 'IDEMPOTENCY_KEY_REUSED'
  // Financial
  | 'OVER_ALLOCATION'
  | 'UNBALANCED_ENTRY'
  | 'IMMUTABLE_POSTING'
  | 'ALLOCATION_ALREADY_REVERSED'
  | 'INSUFFICIENT_PAYMENT_BALANCE'
  | 'INSUFFICIENT_CHARGE_BALANCE'
  | 'CROSS_PROPERTY_ALLOCATION'
  | 'CLOSE_BLOCKED'
  | 'EXCEPTION_UNRESOLVED'
  // Integration
  | 'IMPORT_STATE_INVALID'
  | 'IMPORT_VALIDATION_FAILED'
  | 'FILE_HASH_MISMATCH'
  | 'PROVIDER_ERROR'
  | 'REVERSAL_TARGET_UNKNOWN'
  // Assistant
  | 'ASSISTANT_UNAVAILABLE'
  | 'ASSISTANT_OUTPUT_INVALID'
  | 'ASSISTANT_TOOL_DENIED'
  | 'ASSISTANT_BUDGET_EXCEEDED'
  // Fallback
  | 'INTERNAL_ERROR';

/** Every valid code, so codes arriving from outside can be validated. */
export const DOMAIN_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ORGANIZATION_MISMATCH',
  'PROPERTY_NOT_ASSIGNED',
  'VALIDATION_FAILED',
  'INVALID_MONEY',
  'INVALID_DATE',
  'CURRENCY_MISMATCH',
  'UNSUPPORTED_CURRENCY',
  'NOT_FOUND',
  'CONFLICT',
  'STALE_RECORD',
  'PERIOD_CLOSED',
  'PERIOD_NOT_OPEN',
  'PERIOD_STATE_INVALID',
  'DUPLICATE_EVENT',
  'IDEMPOTENCY_KEY_REUSED',
  'OVER_ALLOCATION',
  'UNBALANCED_ENTRY',
  'IMMUTABLE_POSTING',
  'ALLOCATION_ALREADY_REVERSED',
  'INSUFFICIENT_PAYMENT_BALANCE',
  'INSUFFICIENT_CHARGE_BALANCE',
  'CROSS_PROPERTY_ALLOCATION',
  'CLOSE_BLOCKED',
  'EXCEPTION_UNRESOLVED',
  'IMPORT_STATE_INVALID',
  'IMPORT_VALIDATION_FAILED',
  'FILE_HASH_MISMATCH',
  'PROVIDER_ERROR',
  'REVERSAL_TARGET_UNKNOWN',
  'ASSISTANT_UNAVAILABLE',
  'ASSISTANT_OUTPUT_INVALID',
  'ASSISTANT_TOOL_DENIED',
  'ASSISTANT_BUDGET_EXCEEDED',
  'INTERNAL_ERROR',
] as const satisfies readonly DomainErrorCode[];

const DOMAIN_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(DOMAIN_ERROR_CODES);

export function isDomainErrorCode(value: unknown): value is DomainErrorCode {
  return typeof value === 'string' && DOMAIN_ERROR_CODE_SET.has(value);
}

export interface DomainErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  /** True when retrying the same request unchanged could succeed later. */
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(code: DomainErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    this.retryable = options.retryable ?? false;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

export function hasErrorCode(value: unknown, code: DomainErrorCode): boolean {
  return isDomainError(value) && value.code === code;
}

// --- Construction helpers --------------------------------------------------

export function forbidden(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError('FORBIDDEN', message, { details });
}

export function notFound(entity: string, id: string): DomainError {
  return new DomainError('NOT_FOUND', `${entity} not found`, { details: { entity, id } });
}

export function validationFailed(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError('VALIDATION_FAILED', message, { details });
}

export function conflict(
  code: Extract<
    DomainErrorCode,
    'CONFLICT' | 'STALE_RECORD' | 'IDEMPOTENCY_KEY_REUSED' | 'DUPLICATE_EVENT'
  >,
  message: string,
  details?: Record<string, unknown>,
): DomainError {
  return new DomainError(code, message, { details });
}

export function periodClosed(propertyId: string, period: string): DomainError {
  return new DomainError(
    'PERIOD_CLOSED',
    `Accounting period ${period} is closed for this property and rejects financial changes.`,
    { details: { propertyId, period } },
  );
}

export function overAllocation(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError('OVER_ALLOCATION', message, { details });
}

export function staleRecord(
  entity: string,
  id: string,
  expectedVersion: number,
  actualVersion: number,
): DomainError {
  return new DomainError(
    'STALE_RECORD',
    `${entity} changed since it was read. Reload and review the current values before retrying.`,
    { details: { entity, id, expectedVersion, actualVersion } },
  );
}

/** Wraps an unknown thrown value so callers always see a DomainError. */
export function toDomainError(value: unknown): DomainError {
  if (isDomainError(value)) return value;
  if (value instanceof Error) {
    // Money/date errors carry their own recognised code; anything else is internal.
    const code = (value as { code?: unknown }).code;
    const known = isDomainErrorCode(code) ? code : 'INTERNAL_ERROR';
    return new DomainError(known, value.message, { cause: value });
  }
  return new DomainError('INTERNAL_ERROR', 'Unexpected error', { cause: value });
}
