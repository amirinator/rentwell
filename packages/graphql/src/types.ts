/**
 * The TypeScript face of the GraphQL contract.
 *
 * Enumerations are re-exported from `@rentwell/domain` rather than redeclared,
 * so there is exactly one definition of `ChargeStatus` in the codebase and the
 * SDL, the database and the resolvers cannot disagree about its members. The
 * parity test in `packages/graphql/test/schema.test.ts` checks the SDL against
 * these same constants.
 *
 * Input and payload shapes are declared here. They are the hand-maintained part
 * of the contract; `pnpm --filter @rentwell/graphql codegen` regenerates the
 * fuller operation types used by the web client from the SDL.
 */

import type {
  AllocationStatus,
  AssistantRunStatus,
  ChargeStatus,
  ChargeType,
  ExceptionCategory,
  ExceptionResolution,
  ExceptionSeverity,
  ExceptionStatus,
  ImportStatus,
  JournalEventType,
  LedgerAccountCode,
  LocalDate,
  MatchStrategy,
  OccupancyStatus,
  PeriodKey,
  PeriodStatus,
  PropertyStatus,
  Role,
  SuggestionStatus,
  TransactionDirection,
  TransactionSource,
  TransactionStatus,
} from '@rentwell/domain';

export type {
  AllocationStatus,
  AssistantRunStatus,
  ChargeStatus,
  ChargeType,
  ExceptionCategory,
  ExceptionResolution,
  ExceptionSeverity,
  ExceptionStatus,
  ImportStatus,
  JournalEventType,
  LedgerAccountCode,
  MatchStrategy,
  OccupancyStatus,
  PeriodStatus,
  PropertyStatus,
  Role,
  SuggestionStatus,
  TransactionDirection,
  TransactionSource,
  TransactionStatus,
};

/** ISO-8601 instant string, always UTC. */
export type DateTimeString = string;

export interface GqlMoney {
  cents: number;
  currency: string;
  formatted: string;
}

export interface MoneyInput {
  cents: number;
  currency: string;
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface Edge<T> {
  cursor: string;
  node: T;
}

export interface Connection<T> {
  edges: Edge<T>[];
  pageInfo: PageInfo;
  totalCount: number;
}

// --------------------------------------------------------------------------
// Filters
// --------------------------------------------------------------------------

export interface PortfolioFilter {
  propertyIds?: string[] | null;
  period: PeriodKey;
  asOfDate?: LocalDate | null;
  tenantId?: string | null;
}

export interface ReceivableFilter {
  propertyIds?: string[] | null;
  tenantId?: string | null;
  leaseId?: string | null;
  period?: PeriodKey | null;
  statuses?: ChargeStatus[] | null;
  dueBefore?: LocalDate | null;
  onlyOutstanding?: boolean | null;
  asOfDate?: LocalDate | null;
}

export interface TransactionFilter {
  propertyIds?: string[] | null;
  bankAccountId?: string | null;
  period?: PeriodKey | null;
  statuses?: TransactionStatus[] | null;
  postedFrom?: LocalDate | null;
  postedTo?: LocalDate | null;
  search?: string | null;
  onlyUnreconciled?: boolean | null;
}

export interface ExceptionFilter {
  propertyIds?: string[] | null;
  statuses?: ExceptionStatus[] | null;
  categories?: ExceptionCategory[] | null;
  severities?: ExceptionSeverity[] | null;
  assignedToUserId?: string | null;
  period?: PeriodKey | null;
  onlyBlocking?: boolean | null;
}

export interface JournalFilter {
  propertyId: string;
  period?: PeriodKey | null;
  eventTypes?: JournalEventType[] | null;
  accountCode?: LedgerAccountCode | null;
  sourceId?: string | null;
}

export interface AuditFilter {
  propertyIds?: string[] | null;
  entityType?: string | null;
  entityId?: string | null;
  actorUserId?: string | null;
  actions?: string[] | null;
  from?: DateTimeString | null;
  to?: DateTimeString | null;
}

export interface ImportFilter {
  propertyIds?: string[] | null;
  statuses?: ImportStatus[] | null;
}

export interface PaginationArgs {
  first?: number | null;
  after?: string | null;
}

// --------------------------------------------------------------------------
// Mutation inputs
// --------------------------------------------------------------------------

export interface SignInInput {
  email: string;
  password: string;
}

export interface PreviewChargesInput {
  propertyId: string;
  period: PeriodKey;
}

export interface GenerateChargesInput {
  propertyId: string;
  period: PeriodKey;
  expectedGenerationKeys: string[];
  idempotencyKey: string;
}

export interface CreateCreditInput {
  chargeId: string;
  amount: MoneyInput;
  reason: string;
  postingDate?: LocalDate | null;
  idempotencyKey: string;
}

export interface CreateImportInput {
  propertyId: string;
  bankAccountId: string;
  filename: string;
  fileSizeBytes: number;
}

export interface ConfirmImportInput {
  importId: string;
  fileHash: string;
  idempotencyKey: string;
}

export interface AllocationLineInput {
  chargeId: string;
  amount: MoneyInput;
}

export interface ChargeVersionInput {
  chargeId: string;
  version: number;
}

export interface ApproveAllocationsInput {
  transactionId: string;
  suggestionId?: string | null;
  lines?: AllocationLineInput[] | null;
  expectedTransactionVersion: number;
  expectedChargeVersions: ChargeVersionInput[];
  note?: string | null;
  idempotencyKey: string;
}

export interface ReverseAllocationInput {
  allocationId: string;
  reason: string;
  postingDate?: LocalDate | null;
  idempotencyKey: string;
}

export interface AssignExceptionInput {
  exceptionId: string;
  assignedToUserId?: string | null;
  severity?: ExceptionSeverity | null;
  expectedVersion: number;
}

export interface ResolveExceptionInput {
  exceptionId: string;
  resolution: ExceptionResolution;
  reason: string;
  expectedVersion: number;
}

export interface ReopenExceptionInput {
  exceptionId: string;
  reason: string;
  expectedVersion: number;
}

export interface CommentOnExceptionInput {
  exceptionId: string;
  body: string;
}

export interface StartPeriodReviewInput {
  propertyId: string;
  period: PeriodKey;
}

export interface CloseAcknowledgementInput {
  code: string;
  reason?: string | null;
}

export interface ClosePeriodInput {
  propertyId: string;
  period: PeriodKey;
  acknowledgements: CloseAcknowledgementInput[];
  expectedVersion: number;
  idempotencyKey: string;
}

export interface ReopenPeriodInput {
  propertyId: string;
  period: PeriodKey;
  reason: string;
  expectedVersion: number;
}

export interface RegenerateSuggestionsInput {
  transactionId: string;
}

export interface SyncProviderInput {
  connectionId: string;
}

// --------------------------------------------------------------------------
// Helpers shared by resolvers and the web client
// --------------------------------------------------------------------------

/**
 * Bounds a client-supplied page size.
 *
 * Applied in every paginated resolver. An unbounded `first` is the easiest way
 * to turn a cheap query into an expensive one, so the ceiling is enforced on
 * the server rather than trusted from the client.
 */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export function clampPageSize(first: number | null | undefined): number {
  if (first === null || first === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(first) || first < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(first, MAX_PAGE_SIZE);
}
