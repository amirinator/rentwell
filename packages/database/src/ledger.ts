/**
 * Journal writing.
 *
 * `writeJournalEntry` is the only way a journal entry reaches the database.
 * It re-validates that the entry balances (the domain builders already did, but
 * this is the last gate before durable storage), then inserts the entry and its
 * lines in one statement pair inside the caller's transaction.
 *
 * Post-once: the (organizationId, postingEventId) unique index rejects a second
 * insert for the same business event. That rejection is treated as success,
 * because "this event is already posted" is exactly the outcome the caller
 * wanted. Retried workers, redelivered outbox events and double-submitted
 * mutations therefore all converge on one entry.
 */

import {
  DomainError,
  LEDGER_ACCOUNTS,
  assertBalanced,
  type JournalEntryDraft,
  type LedgerAccountCode,
} from '@rentwell/domain';
import { isUniqueViolation, type PrismaTransaction } from './client';
import { centsToDb } from './money';
import { localDateToDb } from './dates';

export interface WriteEntryOptions {
  readonly createdByUserId?: string | null;
  readonly correlationId?: string | null;
}

export interface WriteEntryResult {
  readonly entryId: string | null;
  /** False when the event had already been posted and nothing was written. */
  readonly created: boolean;
}

/**
 * Ensures the five subledger accounts exist for an organization.
 * Idempotent, so it can run on organization creation and again at seed time.
 */
export async function ensureLedgerAccounts(
  tx: PrismaTransaction,
  organizationId: string,
): Promise<Map<LedgerAccountCode, string>> {
  for (const account of LEDGER_ACCOUNTS) {
    await tx.ledgerAccount.upsert({
      where: { organizationId_code: { organizationId, code: account.code } },
      create: {
        organizationId,
        code: account.code,
        name: account.name,
        normalBalance: account.normalBalance,
      },
      update: { name: account.name, normalBalance: account.normalBalance },
    });
  }

  return loadLedgerAccountIds(tx, organizationId);
}

export async function loadLedgerAccountIds(
  tx: PrismaTransaction,
  organizationId: string,
): Promise<Map<LedgerAccountCode, string>> {
  const rows = await tx.ledgerAccount.findMany({
    where: { organizationId },
    select: { id: true, code: true },
  });

  const index = new Map<LedgerAccountCode, string>();
  for (const row of rows) index.set(row.code as LedgerAccountCode, row.id);

  if (index.size !== LEDGER_ACCOUNTS.length) {
    throw new DomainError(
      'INTERNAL_ERROR',
      'The subledger chart of accounts is incomplete for this organization',
      { details: { organizationId, found: index.size, expected: LEDGER_ACCOUNTS.length } },
    );
  }
  return index;
}

/**
 * Writes one balanced journal entry. Returns `created: false` when the posting
 * event was already recorded.
 */
export async function writeJournalEntry(
  tx: PrismaTransaction,
  draft: JournalEntryDraft,
  accountIds: ReadonlyMap<LedgerAccountCode, string>,
  options: WriteEntryOptions = {},
): Promise<WriteEntryResult> {
  assertBalanced(draft);

  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of draft.lines) {
    totalDebit += line.debit.cents;
    totalCredit += line.credit.cents;
  }

  const lines = draft.lines.map((line) => {
    const accountId = accountIds.get(line.accountCode);
    if (!accountId) {
      throw new DomainError('INTERNAL_ERROR', `No ledger account row for ${line.accountCode}`, {
        details: { organizationId: draft.organizationId, accountCode: line.accountCode },
      });
    }
    return {
      accountId,
      accountCode: line.accountCode,
      debitCents: centsToDb(line.debit.cents),
      creditCents: centsToDb(line.credit.cents),
      memo: line.memo,
      tenantId: line.tenantId ?? null,
      leaseId: line.leaseId ?? null,
      chargeId: line.chargeId ?? null,
    };
  });

  try {
    const entry = await tx.journalEntry.create({
      data: {
        organizationId: draft.organizationId,
        propertyId: draft.propertyId,
        postingEventId: draft.postingEventId,
        eventType: draft.eventType,
        currency: draft.currency,
        postingDate: localDateToDb(draft.postingDate),
        businessDate: localDateToDb(draft.businessDate),
        period: draft.period,
        description: draft.description,
        sourceType: draft.sourceType,
        sourceId: draft.sourceId,
        reversesPostingEventId: draft.reversesPostingEventId,
        totalDebitCents: centsToDb(totalDebit),
        totalCreditCents: centsToDb(totalCredit),
        createdByUserId: options.createdByUserId ?? null,
        correlationId: options.correlationId ?? null,
        lines: { create: lines },
      },
      select: { id: true },
    });
    return { entryId: entry.id, created: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Already posted. This is the idempotent path, not a failure.
      const existing = await tx.journalEntry.findUnique({
        where: {
          organizationId_postingEventId: {
            organizationId: draft.organizationId,
            postingEventId: draft.postingEventId,
          },
        },
        select: { id: true },
      });
      return { entryId: existing?.id ?? null, created: false };
    }
    throw error;
  }
}

/** Writes several entries, short-circuiting on the first genuine failure. */
export async function writeJournalEntries(
  tx: PrismaTransaction,
  drafts: readonly JournalEntryDraft[],
  accountIds: ReadonlyMap<LedgerAccountCode, string>,
  options: WriteEntryOptions = {},
): Promise<WriteEntryResult[]> {
  const results: WriteEntryResult[] = [];
  for (const draft of drafts) {
    results.push(await writeJournalEntry(tx, draft, accountIds, options));
  }
  return results;
}

export interface PeriodBalanceRow {
  accountCode: string;
  debitCents: bigint;
  creditCents: bigint;
}

/**
 * Per-account debit and credit totals for a property and period, read straight
 * from journal lines. The close checklist compares these with the totals it
 * derives from charge and transaction rows; a disagreement blocks the close.
 */
export async function loadPeriodBalances(
  tx: PrismaTransaction,
  propertyId: string,
  period: string,
): Promise<PeriodBalanceRow[]> {
  return tx.$queryRaw<PeriodBalanceRow[]>`
    SELECT l."accountCode"                     AS "accountCode",
           COALESCE(SUM(l."debitCents"), 0)::bigint  AS "debitCents",
           COALESCE(SUM(l."creditCents"), 0)::bigint AS "creditCents"
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."entryId"
    WHERE e."propertyId" = ${propertyId}::uuid
      AND e."period" = ${period}
    GROUP BY l."accountCode"
  `;
}

/**
 * Cumulative per-account balances for a property up to and including a period.
 * Receivables and unapplied cash are running balances, not period movements,
 * so the dashboard and close snapshot both read them this way.
 */
export async function loadCumulativeBalances(
  tx: PrismaTransaction,
  propertyId: string,
  throughPeriod: string,
): Promise<PeriodBalanceRow[]> {
  return tx.$queryRaw<PeriodBalanceRow[]>`
    SELECT l."accountCode"                     AS "accountCode",
           COALESCE(SUM(l."debitCents"), 0)::bigint  AS "debitCents",
           COALESCE(SUM(l."creditCents"), 0)::bigint AS "creditCents"
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."entryId"
    WHERE e."propertyId" = ${propertyId}::uuid
      AND e."period" <= ${throughPeriod}
    GROUP BY l."accountCode"
  `;
}
