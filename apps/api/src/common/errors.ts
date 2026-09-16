/**
 * GraphQL error translation.
 *
 * Clients branch on `extensions.code`, which comes from the domain error
 * vocabulary and does not change when a message is reworded. Two rules matter:
 *
 *  1. An unexpected error never leaks its message or stack to the client. It is
 *     logged in full with the correlation id and returned as INTERNAL_ERROR
 *     with that id, so support can find it without the client seeing internals.
 *  2. A domain error's `details` are safe to return by construction: the domain
 *     only ever puts identifiers, amounts and versions there.
 */

import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { DomainError, isDomainError, type DomainErrorCode } from '@rentwell/domain';
import type { Logger } from '@rentwell/observability';

/** HTTP status a code maps to, for the REST-ish routes that share this mapping. */
const STATUS_BY_CODE: Partial<Record<DomainErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  PROPERTY_NOT_ASSIGNED: 403,
  ORGANIZATION_MISMATCH: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE_RECORD: 409,
  DUPLICATE_EVENT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  PERIOD_CLOSED: 409,
  PERIOD_NOT_OPEN: 409,
  PERIOD_STATE_INVALID: 409,
  OVER_ALLOCATION: 409,
  ALLOCATION_ALREADY_REVERSED: 409,
  INSUFFICIENT_PAYMENT_BALANCE: 409,
  INSUFFICIENT_CHARGE_BALANCE: 409,
  CLOSE_BLOCKED: 409,
  EXCEPTION_UNRESOLVED: 409,
  IMPORT_STATE_INVALID: 409,
  VALIDATION_FAILED: 400,
  INVALID_MONEY: 400,
  INVALID_DATE: 400,
  CURRENCY_MISMATCH: 400,
  UNSUPPORTED_CURRENCY: 400,
  CROSS_PROPERTY_ALLOCATION: 400,
  IMPORT_VALIDATION_FAILED: 400,
  FILE_HASH_MISMATCH: 400,
  REVERSAL_TARGET_UNKNOWN: 409,
  UNBALANCED_ENTRY: 500,
  IMMUTABLE_POSTING: 409,
  PROVIDER_ERROR: 502,
  ASSISTANT_UNAVAILABLE: 503,
  ASSISTANT_OUTPUT_INVALID: 502,
  ASSISTANT_TOOL_DENIED: 403,
  ASSISTANT_BUDGET_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
};

export function httpStatusForCode(code: DomainErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/** Wraps a DomainError so Apollo carries its code and details. */
export function toGraphQLError(error: DomainError, correlationId: string): GraphQLError {
  return new GraphQLError(error.message, {
    extensions: {
      code: error.code,
      details: error.details,
      retryable: error.retryable,
      correlationId,
      httpStatus: httpStatusForCode(error.code),
    },
  });
}

/**
 * Apollo `formatError` hook.
 *
 * Runs for every error leaving the server, including ones thrown by graphql-js
 * itself (parse, validate, complexity), so nothing escapes without a code.
 */
export function buildErrorFormatter(logger: Logger, isProduction: boolean) {
  return (formatted: GraphQLFormattedError, thrown: unknown): GraphQLFormattedError => {
    const original = unwrap(thrown);
    const correlationId = readCorrelationId(formatted);

    if (isDomainError(original)) {
      return {
        ...formatted,
        message: original.message,
        extensions: {
          ...formatted.extensions,
          code: original.code,
          details: original.details,
          retryable: original.retryable,
          correlationId,
          httpStatus: httpStatusForCode(original.code),
        },
      };
    }

    // Errors graphql-js raises before a resolver runs already carry a useful
    // code (GRAPHQL_VALIDATION_FAILED, BAD_USER_INPUT, ...). They describe the
    // request, not our internals, so they pass through.
    const existingCode = formatted.extensions?.code;
    if (typeof existingCode === 'string' && existingCode !== 'INTERNAL_SERVER_ERROR') {
      return { ...formatted, extensions: { ...formatted.extensions, correlationId } };
    }

    logger.error(
      { err: original, correlationId, path: formatted.path },
      'Unhandled error in GraphQL execution',
    );

    return {
      message: isProduction
        ? 'An unexpected error occurred. Quote the correlation id when reporting it.'
        : `Unexpected error: ${original instanceof Error ? original.message : String(original)}`,
      path: formatted.path,
      extensions: { code: 'INTERNAL_ERROR', correlationId, httpStatus: 500 },
    };
  };
}

function unwrap(thrown: unknown): unknown {
  if (thrown instanceof GraphQLError) return thrown.originalError ?? thrown;
  return thrown;
}

function readCorrelationId(formatted: GraphQLFormattedError): string {
  const value = formatted.extensions?.correlationId;
  return typeof value === 'string' ? value : 'unknown';
}

/** Throws UNAUTHENTICATED when there is no principal. Use before every guard. */
export function requireAuthenticated<T>(access: T | null | undefined): T {
  if (access === null || access === undefined) {
    throw new DomainError('UNAUTHENTICATED', 'Sign in to perform this action');
  }
  return access;
}
