/**
 * Match suggestion generation and storage.
 *
 * Suggestions are computed by the domain engine and stored whole: the lines,
 * the evidence, the score and its components, the rule version, and the record
 * versions they were computed against. Storing all of it is what makes a
 * suggestion auditable months later — a reviewer can see not just what was
 * proposed but why, and against which balances.
 *
 * Nothing here decides anything financial. A suggestion is a proposal until a
 * person approves it, and approval re-validates everything from scratch.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  DomainError,
  MAX_SUGGESTIONS_PER_TRANSACTION,
  chargeOpenBalance,
  generateSuggestions,
  isSuggestionStale,
  type AccessContext,
  type MatchSuggestion,
  type TenantMatchInfo,
} from '@rentwell/domain';
import {
  centsToDb,
  recordAuditEvent,
  toChargeSnapshot,
  toTenantMatchIndex,
  toTransactionSnapshot,
  toJson,
  type ChargeRow,
  type PrismaTransaction,
  type TenantRow,
  type TransactionRow,
  centsFromDb,
} from '@rentwell/database';
import type { Logger } from '@rentwell/observability';
import { PrismaService } from '../prisma/prisma.service';
import { CLOCK, LOGGER } from '../common/tokens';
import type { Clock } from '../common/clock';
import { authorizeProperty } from '../common/guards';
import type { GqlContext } from '../common/context';

/** Open charges considered per payment. Bounds the cost of one generation. */
const CANDIDATE_CHARGE_LIMIT = 200;

export interface StoredSuggestion extends MatchSuggestion {
  readonly id: string;
  readonly status: string;
}

@Injectable()
export class SuggestionsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Recomputes and stores suggestions for one payment.
   *
   * Runs in the caller's transaction when given one, so the ingestion worker
   * can create a payment and its suggestions atomically.
   */
  async generateFor(
    db: PrismaTransaction,
    access: AccessContext,
    transactionId: string,
    correlationId: string | null,
  ): Promise<MatchSuggestion[]> {
    const transaction = await db.bankTransaction.findFirst({
      where: { id: transactionId, organizationId: access.organizationId },
    });
    if (!transaction) {
      throw new DomainError('NOT_FOUND', 'Payment not found', { details: { id: transactionId } });
    }

    const snapshot = toTransactionSnapshot(transaction as unknown as TransactionRow);

    const [chargeRows, tenantRows, closedPeriods] = await Promise.all([
      db.charge.findMany({
        where: {
          propertyId: snapshot.propertyId,
          organizationId: access.organizationId,
          status: { in: ['POSTED', 'SETTLED'] },
          currency: snapshot.currency,
        },
        include: { lease: { select: { paymentReference: true } } },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: CANDIDATE_CHARGE_LIMIT,
      }),
      db.tenant.findMany({
        where: { organizationId: access.organizationId, isActive: true },
        select: {
          id: true,
          displayName: true,
          paymentReference: true,
          leases: {
            where: { propertyId: snapshot.propertyId },
            select: { id: true, paymentReference: true },
          },
        },
      }),
      db.accountingPeriod.findMany({
        where: { propertyId: snapshot.propertyId, status: 'CLOSED' },
        select: { period: true },
      }),
    ]);

    const charges = chargeRows
      .map((row) => toChargeSnapshot(row as unknown as ChargeRow))
      .filter((charge) => chargeOpenBalance(charge).cents > 0);

    const tenants: ReadonlyMap<string, TenantMatchInfo> = toTenantMatchIndex(
      tenantRows as unknown as TenantRow[],
    );

    const suggestions = generateSuggestions({
      transaction: snapshot,
      openCharges: charges,
      tenants,
      closedPeriods: new Set(closedPeriods.map((row) => row.period)),
      now: this.clock.now(),
    });

    await this.store(db, access, transactionId, suggestions);

    await recordAuditEvent(db, {
      organizationId: access.organizationId,
      propertyId: snapshot.propertyId,
      actorUserId: access.isSystem === true ? null : access.userId,
      actorSystem: access.isSystem === true ? 'suggestion-worker' : null,
      action: AuditAction.SUGGESTIONS_GENERATED,
      entityType: 'BankTransaction',
      entityId: transactionId,
      metadata: {
        count: suggestions.length,
        ruleVersion: suggestions[0]?.ruleVersion ?? null,
        topScore: suggestions[0]?.score ?? null,
        candidateCharges: charges.length,
      },
      correlationId,
      occurredAt: this.clock.now(),
    });

    return suggestions;
  }

  /**
   * Replaces the stored proposals for a payment.
   *
   * Existing PROPOSED rows that the new run did not reproduce are marked
   * SUPERSEDED rather than deleted, so a suggestion an accountant was looking
   * at does not vanish from the audit trail. Approved and rejected rows are
   * never touched.
   */
  private async store(
    db: PrismaTransaction,
    access: AccessContext,
    transactionId: string,
    suggestions: readonly MatchSuggestion[],
  ): Promise<void> {
    const fingerprints = suggestions.map((suggestion) => suggestion.fingerprint);

    await db.matchSuggestion.updateMany({
      where: {
        transactionId,
        status: 'PROPOSED',
        ...(fingerprints.length > 0 ? { fingerprint: { notIn: fingerprints } } : {}),
      },
      data: { status: 'SUPERSEDED', supersededAt: this.clock.now() },
    });

    for (const suggestion of suggestions) {
      const data = {
        organizationId: access.organizationId,
        transactionId,
        strategy: suggestion.strategy,
        status: 'PROPOSED' as const,
        fingerprint: suggestion.fingerprint,
        lines: toJson(
          suggestion.lines.map((line) => ({
            chargeId: line.chargeId,
            amountCents: line.amount.cents,
            currency: line.amount.currency,
          })),
        ),
        totalCents: centsToDb(suggestion.totalAllocated.cents),
        remainderCents: centsToDb(suggestion.unappliedRemainder.cents),
        score: suggestion.score,
        scoreComponents: toJson(suggestion.scoreComponents),
        evidence: toJson(suggestion.evidence),
        warnings: toJson(suggestion.warnings),
        ruleVersion: suggestion.ruleVersion,
        recordVersions: toJson(suggestion.recordVersions),
        generatedAt: new Date(suggestion.generatedAt),
        supersededAt: null,
      };

      await db.matchSuggestion.upsert({
        where: {
          transactionId_fingerprint: { transactionId, fingerprint: suggestion.fingerprint },
        },
        create: data,
        // A re-run of the same proposal refreshes its evidence and revives it
        // if a previous run had superseded it.
        update: data,
      });
    }
  }

  /** Regenerates on demand from the reconciliation workbench. */
  async regenerate(ctx: GqlContext, transactionId: string): Promise<MatchSuggestion[]> {
    const transaction = await this.prisma.client.bankTransaction.findUnique({
      where: { id: transactionId },
      include: { property: { select: { id: true, organizationId: true } } },
    });
    if (!transaction) {
      throw new DomainError('NOT_FOUND', 'Payment not found', { details: { id: transactionId } });
    }

    const access = authorizeProperty(ctx, 'suggestion:regenerate', transaction.property);

    const result = await this.prisma.run((tx) =>
      this.generateFor(tx, access, transactionId, ctx.correlationId),
    );

    this.logger.info(
      { transactionId, count: result.length, correlationId: ctx.correlationId },
      'Regenerated match suggestions',
    );

    return result;
  }

  /**
   * Reads stored suggestions and marks each one stale or current.
   *
   * Staleness is computed at read time against live balances, so the workbench
   * can grey out a proposal whose underlying records moved while the accountant
   * was looking at something else, instead of letting them approve it and
   * receive a conflict.
   */
  async listForTransaction(
    ctx: GqlContext,
    transactionId: string,
  ): Promise<(StoredSuggestion & { isStale: boolean })[]> {
    const transaction = await this.prisma.client.bankTransaction.findUnique({
      where: { id: transactionId },
      include: { property: { select: { id: true, organizationId: true } } },
    });
    if (!transaction) {
      throw new DomainError('NOT_FOUND', 'Payment not found', { details: { id: transactionId } });
    }

    authorizeProperty(ctx, 'suggestion:read', transaction.property);

    const rows = await this.prisma.client.matchSuggestion.findMany({
      where: { transactionId, status: { in: ['PROPOSED', 'APPROVED'] } },
      orderBy: [{ score: 'desc' }, { strategy: 'asc' }, { id: 'asc' }],
      take: MAX_SUGGESTIONS_PER_TRANSACTION,
    });
    if (rows.length === 0) return [];

    const snapshot = toTransactionSnapshot(transaction as unknown as TransactionRow);
    const referencedChargeIds = new Set<string>();
    for (const row of rows) {
      for (const chargeId of Object.keys(readRecordVersions(row.recordVersions).charges)) {
        referencedChargeIds.add(chargeId);
      }
    }

    const chargeRows = await this.prisma.client.charge.findMany({
      where: { id: { in: [...referencedChargeIds] } },
      include: { lease: { select: { paymentReference: true } } },
    });
    const charges = chargeRows.map((row) => toChargeSnapshot(row as unknown as ChargeRow));

    return rows.map((row) => {
      const rebuilt = rehydrate(row, snapshot.currency);
      return {
        ...rebuilt,
        id: row.id,
        status: row.status,
        isStale: isSuggestionStale(rebuilt, snapshot, charges),
      };
    });
  }
}

interface SuggestionRow {
  id: string;
  transactionId: string;
  strategy: string;
  status: string;
  fingerprint: string;
  lines: unknown;
  totalCents: bigint | number;
  remainderCents: bigint | number;
  score: unknown;
  scoreComponents: unknown;
  evidence: unknown;
  warnings: unknown;
  ruleVersion: string;
  recordVersions: unknown;
  generatedAt: Date;
}

function readRecordVersions(value: unknown): {
  transaction: number;
  charges: Record<string, number>;
} {
  const parsed = (value ?? {}) as { transaction?: unknown; charges?: unknown };
  return {
    transaction: typeof parsed.transaction === 'number' ? parsed.transaction : -1,
    charges:
      parsed.charges && typeof parsed.charges === 'object'
        ? (parsed.charges as Record<string, number>)
        : {},
  };
}

/**
 * Rebuilds a domain suggestion from its stored row, for staleness checking.
 *
 * The currency comes from the payment the suggestion belongs to rather than
 * being assumed: a stored row carries amounts, and the amounts alone do not say
 * what they are denominated in.
 */
function rehydrate(row: SuggestionRow, currency: string): MatchSuggestion {
  const lines = Array.isArray(row.lines) ? row.lines : [];

  return {
    fingerprint: row.fingerprint,
    transactionId: row.transactionId,
    strategy: row.strategy as MatchSuggestion['strategy'],
    lines: lines.map((entry) => {
      const line = entry as { chargeId: string; amountCents: number; currency?: string };
      return {
        chargeId: line.chargeId,
        amount: { cents: line.amountCents, currency: line.currency ?? currency },
      };
    }),
    totalAllocated: { cents: centsFromDb(row.totalCents), currency },
    unappliedRemainder: { cents: centsFromDb(row.remainderCents), currency },
    score: Number(row.score),
    scoreComponents: row.scoreComponents as MatchSuggestion['scoreComponents'],
    evidence: (Array.isArray(row.evidence) ? row.evidence : []) as MatchSuggestion['evidence'],
    warnings: (Array.isArray(row.warnings) ? row.warnings : []) as MatchSuggestion['warnings'],
    ruleVersion: row.ruleVersion,
    recordVersions: readRecordVersions(row.recordVersions),
    generatedAt: row.generatedAt.toISOString(),
  };
}
