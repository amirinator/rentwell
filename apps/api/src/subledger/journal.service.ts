/**
 * Subledger reads.
 *
 * Journal entries are immutable through every application interface: there is
 * no update and no delete anywhere in this service, and none anywhere else in
 * the codebase. A correction is a new, linked entry.
 *
 * `netDebitMinusCredit` is returned alongside every entry list. It must be zero
 * over any complete set of entries; a non-zero value is a defect, and surfacing
 * it in the API is what lets the close checklist and the browser tests notice
 * it without a separate reconciliation job.
 */

import { Injectable } from '@nestjs/common';
import {
  DomainError,
  signedEffect,
  type LedgerAccountCode,
  type PeriodKey,
} from '@rentwell/domain';
import { centsFromDb, loadCumulativeBalances, loadPeriodBalances } from '@rentwell/database';
import { clampPageSize, type JournalFilter } from '@rentwell/graphql';
import { PrismaService } from '../prisma/prisma.service';
import { authorize, authorizeProperty } from '../common/guards';
import {
  andWhere,
  buildConnection,
  decodeOptionalCursor,
  encodeCursor,
} from '../common/pagination';
import type { GqlContext } from '../common/context';

@Injectable()
export class JournalService {
  constructor(private readonly prisma: PrismaService) {}

  async listEntries(
    ctx: GqlContext,
    filter: JournalFilter,
    args: { first?: number | null; after?: string | null },
  ) {
    const access = authorize(ctx, 'journal:read');
    const property = await this.requireProperty(ctx, filter.propertyId);
    const limit = clampPageSize(args.first);
    const cursor = decodeOptionalCursor(args.after);

    const baseWhere = andWhere(
      { organizationId: access.organizationId, propertyId: property.id },
      filter.period ? { period: filter.period } : undefined,
      filter.eventTypes && filter.eventTypes.length > 0
        ? { eventType: { in: filter.eventTypes } }
        : undefined,
      filter.sourceId ? { sourceId: filter.sourceId } : undefined,
      filter.accountCode ? { lines: { some: { accountCode: filter.accountCode } } } : undefined,
    );

    // Newest first, tie-broken by id so the cursor is stable for entries that
    // share a millisecond — which happens constantly inside one transaction.
    const where = andWhere(
      baseWhere,
      cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(cursor.sortValue) } },
              { AND: [{ createdAt: new Date(cursor.sortValue) }, { id: { lt: cursor.id } }] },
            ],
          }
        : undefined,
    );

    const [rows, totalCount, netRows] = await Promise.all([
      this.prisma.client.journalEntry.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: { lines: { orderBy: { id: 'asc' } } },
      }),
      this.prisma.client.journalEntry.count({ where: baseWhere }),
      this.prisma.client.journalEntry.aggregate({
        where: baseWhere,
        _sum: { totalDebitCents: true, totalCreditCents: true },
      }),
    ]);

    const connection = buildConnection({
      rows,
      limit,
      totalCount,
      hasPreviousPage: cursor !== null,
      cursorFor: (row) => encodeCursor(row.createdAt, row.id),
      toNode: (row) => row,
    });

    return {
      ...connection,
      currency: property.currency.trim(),
      netDebitMinusCreditCents:
        centsFromDb(netRows._sum.totalDebitCents) - centsFromDb(netRows._sum.totalCreditCents),
    };
  }

  /**
   * Per-account balances for a property.
   *
   * Income accounts report the period's movement, because income is earned in a
   * period and does not carry forward. Receivables, cash clearing and unapplied
   * cash report a cumulative balance, because those are positions that persist
   * until something settles them. Mixing the two would make the totals look
   * wrong in exactly the month a tenant falls behind.
   */
  async accountBalances(ctx: GqlContext, propertyId: string, period: PeriodKey) {
    authorize(ctx, 'journal:read');
    const property = await this.requireProperty(ctx, propertyId);
    const currency = property.currency.trim();

    const [periodRows, cumulativeRows] = await Promise.all([
      loadPeriodBalances(this.prisma.client, property.id, period),
      loadCumulativeBalances(this.prisma.client, property.id, period),
    ]);

    const periodByAccount = new Map(periodRows.map((row) => [row.accountCode, row]));
    const cumulativeByAccount = new Map(cumulativeRows.map((row) => [row.accountCode, row]));

    const POSITION_ACCOUNTS = new Set(['ACCOUNTS_RECEIVABLE', 'CASH_CLEARING', 'UNAPPLIED_CASH']);

    const codes = new Set([...periodByAccount.keys(), ...cumulativeByAccount.keys()]);

    return [...codes].sort().map((code) => {
      const source = POSITION_ACCOUNTS.has(code)
        ? cumulativeByAccount.get(code)
        : periodByAccount.get(code);

      const debit = centsFromDb(source?.debitCents ?? 0n);
      const credit = centsFromDb(source?.creditCents ?? 0n);

      return {
        accountCode: code,
        currency,
        debitCents: debit,
        creditCents: credit,
        balanceCents: signedEffect(code as LedgerAccountCode, debit, credit),
      };
    });
  }

  private async requireProperty(ctx: GqlContext, propertyId: string) {
    const property = await this.prisma.client.property.findUnique({
      where: { id: propertyId },
      select: { id: true, organizationId: true, currency: true },
    });
    if (!property) {
      throw new DomainError('NOT_FOUND', 'Property not found', { details: { id: propertyId } });
    }
    authorizeProperty(ctx, 'journal:read', property);
    return property;
  }

  /**
   * Receivables derived from journal lines alone.
   *
   * Exposed so integration tests and the close checklist can compare it with
   * the figure derived from charge rows. Two independent derivations agreeing
   * is the evidence that the subledger and the operational records match.
   */
  async receivablesFromJournal(propertyId: string, throughPeriod: PeriodKey): Promise<number> {
    const rows = await loadCumulativeBalances(this.prisma.client, propertyId, throughPeriod);
    const row = rows.find((entry) => entry.accountCode === 'ACCOUNTS_RECEIVABLE');
    return row ? centsFromDb(row.debitCents) - centsFromDb(row.creditCents) : 0;
  }
}
