import { Args, Context, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { DomainError } from '@rentwell/domain';
import {
  clampPageSize,
  type ConfirmImportInput,
  type CreateImportInput,
  type ImportFilter,
  type SyncProviderInput,
  type TransactionFilter,
} from '@rentwell/graphql';
import { PrismaService } from '../prisma/prisma.service';
import { authorize, resolvePropertyScope } from '../common/guards';
import {
  andWhere,
  buildConnection,
  decodeOptionalCursor,
  encodeCursor,
} from '../common/pagination';
import { toGqlMoney } from '../common/money';
import {
  allocationView,
  exceptionView,
  propertyView,
  transactionView,
  type PropertyRowForView,
  type TransactionRowForView,
} from '../common/view';
import type { GqlContext } from '../common/context';
import { ImportsService } from './imports.service';
import { TransactionsService } from './transactions.service';
import { SuggestionResolver } from '../reconciliation/reconciliation.resolver';

@Resolver('ImportBatch')
export class ImportResolver {
  constructor(
    private readonly imports: ImportsService,
    private readonly prisma: PrismaService,
  ) {}

  @Query('imports')
  async list(
    @Args('filter') filter: ImportFilter | null,
    @Args('first') first: number | null,
    @Args('after') after: string | null,
    @Context() ctx: GqlContext,
  ) {
    const access = authorize(ctx, 'import:read');
    const scope = resolvePropertyScope(access, filter?.propertyIds);
    const limit = clampPageSize(first);
    const cursor = decodeOptionalCursor(after);

    const baseWhere = andWhere(
      { organizationId: access.organizationId },
      scope === null ? undefined : { propertyId: { in: scope } },
      filter?.statuses && filter.statuses.length > 0
        ? { status: { in: filter.statuses } }
        : undefined,
    );

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

    const [rows, totalCount] = await Promise.all([
      this.prisma.client.importBatch.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.prisma.client.importBatch.count({ where: baseWhere }),
    ]);

    return buildConnection({
      rows,
      limit,
      totalCount,
      hasPreviousPage: cursor !== null,
      cursorFor: (row) => encodeCursor(row.createdAt, row.id),
      toNode: (row) => importView(row),
    });
  }

  @Query('importBatch')
  async one(@Args('id') id: string, @Context() ctx: GqlContext) {
    const access = authorize(ctx, 'import:read');
    const row = await this.prisma.client.importBatch.findFirst({
      where: { id, organizationId: access.organizationId },
    });
    if (!row) throw new DomainError('NOT_FOUND', 'Import not found', { details: { id } });

    const scope = resolvePropertyScope(access, null);
    if (scope !== null && !scope.includes(row.propertyId)) {
      throw new DomainError('PROPERTY_NOT_ASSIGNED', 'You are not assigned to this property');
    }
    return importView(row);
  }

  @ResolveField('property')
  async property(@Parent() batch: { propertyId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.property.load(batch.propertyId);
    return row ? propertyView(row as unknown as PropertyRowForView) : null;
  }

  @ResolveField('bankAccount')
  async bankAccount(@Parent() batch: { bankAccountId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.bankAccount.load(batch.bankAccountId);
    if (!row) return null;
    return {
      id: row.id,
      label: row.label as string,
      maskedNumber: row.maskedNumber as string,
      currency: (row.currency as string).trim(),
      isActive: row.isActive as boolean,
      propertyId: row.propertyId as string,
      provider: null,
      lastSyncedAt: null,
    };
  }

  /**
   * Null unless the viewer may download the source file.
   *
   * Returning null rather than raising keeps the rest of the import view usable
   * for a role that can see progress but not the underlying payment data.
   */
  @ResolveField('downloadUrl')
  async downloadUrl(@Parent() batch: { id: string }, @Context() ctx: GqlContext) {
    try {
      return await this.imports.downloadUrl(ctx, batch.id);
    } catch (error) {
      if (
        error instanceof DomainError &&
        ['FORBIDDEN', 'PROPERTY_NOT_ASSIGNED'].includes(error.code)
      ) {
        return null;
      }
      throw error;
    }
  }

  @ResolveField('rows')
  async rows(
    @Parent() batch: { id: string },
    @Args('first') first: number | null,
    @Args('after') after: string | null,
    @Args('outcome') outcome: string | null,
  ) {
    const limit = clampPageSize(first);
    const cursor = decodeOptionalCursor(after);

    const baseWhere = andWhere({ importBatchId: batch.id }, outcome ? { outcome } : undefined);
    const where = andWhere(
      baseWhere,
      cursor ? { rowNumber: { gt: Number(cursor.sortValue) } } : undefined,
    );

    const [rows, totalCount] = await Promise.all([
      this.prisma.client.importRow.findMany({
        where,
        orderBy: { rowNumber: 'asc' },
        take: limit + 1,
      }),
      this.prisma.client.importRow.count({ where: baseWhere }),
    ]);

    return buildConnection({
      rows,
      limit,
      totalCount,
      hasPreviousPage: cursor !== null,
      cursorFor: (row) => encodeCursor(String(row.rowNumber), row.id),
      toNode: (row) => ({
        id: row.id,
        rowNumber: row.rowNumber,
        externalId: row.externalId,
        outcome: row.outcome,
        message: row.message,
        rawValues: row.rawValues ?? {},
        transactionId: row.transactionId,
      }),
    });
  }
}

@Resolver('ImportRow')
export class ImportRowResolver {
  @ResolveField('transaction')
  async transaction(@Parent() row: { transactionId: string | null }, @Context() ctx: GqlContext) {
    if (!row.transactionId) return null;
    const found = await ctx.loaders.transaction.load(row.transactionId);
    return found ? transactionView(found as unknown as TransactionRowForView) : null;
  }
}

@Resolver('BankTransaction')
export class TransactionResolver {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly suggestionResolver: SuggestionResolver,
    private readonly prisma: PrismaService,
  ) {}

  @Query('transactions')
  async list(
    @Args('filter') filter: TransactionFilter,
    @Args('first') first: number | null,
    @Args('after') after: string | null,
    @Context() ctx: GqlContext,
  ) {
    const access = authorize(ctx, 'transaction:read');
    const scope = resolvePropertyScope(access, filter.propertyIds);
    const limit = clampPageSize(first);
    const cursor = decodeOptionalCursor(after);

    const baseWhere = andWhere(
      { organizationId: access.organizationId },
      scope === null ? undefined : { propertyId: { in: scope } },
      filter.bankAccountId ? { bankAccountId: filter.bankAccountId } : undefined,
      filter.period ? { period: filter.period } : undefined,
      filter.statuses && filter.statuses.length > 0
        ? { status: { in: filter.statuses } }
        : undefined,
      filter.postedFrom
        ? { postedDate: { gte: new Date(`${filter.postedFrom}T00:00:00.000Z`) } }
        : undefined,
      filter.postedTo
        ? { postedDate: { lte: new Date(`${filter.postedTo}T00:00:00.000Z`) } }
        : undefined,
      filter.onlyUnreconciled
        ? { status: { in: ['UNAPPLIED', 'PARTIALLY_ALLOCATED'] } }
        : undefined,
      // Search covers the reference and the payer-supplied description. Both
      // are matched as plain substrings; neither is interpreted.
      filter.search
        ? {
            OR: [
              { reference: { contains: filter.search, mode: 'insensitive' } },
              { description: { contains: filter.search, mode: 'insensitive' } },
              { externalId: { contains: filter.search, mode: 'insensitive' } },
            ],
          }
        : undefined,
    );

    const where = andWhere(
      baseWhere,
      cursor
        ? {
            OR: [
              { postedDate: { lt: new Date(`${cursor.sortValue}T00:00:00.000Z`) } },
              {
                AND: [
                  { postedDate: new Date(`${cursor.sortValue}T00:00:00.000Z`) },
                  { id: { lt: cursor.id } },
                ],
              },
            ],
          }
        : undefined,
    );

    const [rows, totalCount, totals] = await Promise.all([
      this.prisma.client.bankTransaction.findMany({
        where,
        orderBy: [{ postedDate: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.prisma.client.bankTransaction.count({ where: baseWhere }),
      this.transactions.totals(access, baseWhere),
    ]);

    const currency = rows[0]?.currency.trim() ?? 'USD';

    const connection = buildConnection({
      rows,
      limit,
      totalCount,
      hasPreviousPage: cursor !== null,
      cursorFor: (row) => encodeCursor(row.postedDate, row.id),
      toNode: (row) => transactionView(row as unknown as TransactionRowForView),
    });

    return {
      ...connection,
      totals: {
        received: toGqlMoney(totals.received, currency),
        allocated: toGqlMoney(totals.allocated, currency),
        unapplied: toGqlMoney(totals.unapplied, currency),
      },
    };
  }

  @Query('transaction')
  async one(@Args('id') id: string, @Context() ctx: GqlContext) {
    const access = authorize(ctx, 'transaction:read');
    const row = await this.prisma.client.bankTransaction.findFirst({
      where: { id, organizationId: access.organizationId },
    });
    if (!row) throw new DomainError('NOT_FOUND', 'Payment not found', { details: { id } });

    const scope = resolvePropertyScope(access, null);
    if (scope !== null && !scope.includes(row.propertyId)) {
      throw new DomainError('PROPERTY_NOT_ASSIGNED', 'You are not assigned to this property');
    }
    return transactionView(row as unknown as TransactionRowForView);
  }

  @ResolveField('property')
  async property(@Parent() transaction: { propertyId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.property.load(transaction.propertyId);
    return row ? propertyView(row as unknown as PropertyRowForView) : null;
  }

  @ResolveField('bankAccount')
  async bankAccount(@Parent() transaction: { bankAccountId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.bankAccount.load(transaction.bankAccountId);
    if (!row) return null;
    return {
      id: row.id,
      label: row.label as string,
      maskedNumber: row.maskedNumber as string,
      currency: (row.currency as string).trim(),
      isActive: row.isActive as boolean,
      propertyId: row.propertyId as string,
      provider: null,
      lastSyncedAt: null,
    };
  }

  @ResolveField('allocations')
  async allocations(@Parent() transaction: { id: string }, @Context() ctx: GqlContext) {
    const rows = await ctx.loaders.allocationsByTransaction.load(transaction.id);
    return rows.map((row) => allocationView(row as never));
  }

  /**
   * Stored suggestions for this payment.
   *
   * Delegated to the suggestion resolver so staleness is computed in exactly
   * one place; a payment's suggestions must look the same whether they were
   * reached through `matchSuggestions` or through this field.
   */
  @ResolveField('suggestions')
  async suggestions(@Parent() transaction: { id: string }, @Context() ctx: GqlContext) {
    return this.suggestionResolver.matchSuggestions(transaction.id, ctx);
  }

  @ResolveField('exception')
  async exception(@Parent() transaction: { id: string }, @Context() ctx: GqlContext) {
    // Batched: the transactions list selects this field on every row.
    const row = await ctx.loaders.openExceptionByTransaction.load(transaction.id);
    return row ? exceptionView(row as unknown as Parameters<typeof exceptionView>[0]) : null;
  }
}

@Resolver('Mutation')
export class IngestionMutationsResolver {
  constructor(
    private readonly imports: ImportsService,
    private readonly transactions: TransactionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Mutation('createImportUpload')
  async createImportUpload(@Args('input') input: CreateImportInput, @Context() ctx: GqlContext) {
    return this.imports.createUpload(ctx, input);
  }

  @Mutation('validateImport')
  async validateImport(@Args('importId') importId: string, @Context() ctx: GqlContext) {
    const summary = await this.imports.validate(ctx, importId);
    return {
      importId: summary.importId,
      status: summary.status,
      totalRows: summary.totalRows,
      validRows: summary.validRows,
      errors: [...summary.errors],
      fileHash: summary.fileHash,
    };
  }

  @Mutation('confirmImport')
  async confirmImport(@Args('input') input: ConfirmImportInput, @Context() ctx: GqlContext) {
    const importId = await this.imports.confirm(ctx, input);
    return importView(
      await this.prisma.client.importBatch.findUniqueOrThrow({ where: { id: importId } }),
    );
  }

  @Mutation('cancelImport')
  async cancelImport(@Args('importId') importId: string, @Context() ctx: GqlContext) {
    const id = await this.imports.cancel(ctx, importId);
    return importView(await this.prisma.client.importBatch.findUniqueOrThrow({ where: { id } }));
  }

  @Mutation('retryImport')
  async retryImport(@Args('importId') importId: string, @Context() ctx: GqlContext) {
    const id = await this.imports.retry(ctx, importId);
    return importView(await this.prisma.client.importBatch.findUniqueOrThrow({ where: { id } }));
  }

  /**
   * Requests a pull from the banking provider.
   *
   * Returns as soon as the request is durably queued, not when the sync
   * finishes: a provider conversation is slow and retry-prone, and holding an
   * HTTP request open for it would make a transient provider failure look like
   * an application failure.
   */
  @Mutation('syncProvider')
  async syncProvider(
    @Args('input') input: SyncProviderInput,
    @Context() ctx: GqlContext,
  ): Promise<boolean> {
    return this.transactions.requestSync(ctx, input.connectionId);
  }
}

function importView(row: {
  id: string;
  status: string;
  originalFilename: string;
  fileSizeBytes: number;
  fileHash: string;
  totalRows: number;
  processedRows: number;
  createdRows: number;
  duplicateRows: number;
  failedRows: number;
  checkpointRow: number;
  validationErrors: unknown;
  errorMessage: string | null;
  attempts: number;
  propertyId: string;
  bankAccountId: string;
  createdAt: Date;
  confirmedAt: Date | null;
  completedAt: Date | null;
}) {
  return {
    id: row.id,
    status: row.status,
    originalFilename: row.originalFilename,
    fileSizeBytes: row.fileSizeBytes,
    fileHash: row.fileHash,
    totalRows: row.totalRows,
    processedRows: row.processedRows,
    createdRows: row.createdRows,
    duplicateRows: row.duplicateRows,
    failedRows: row.failedRows,
    checkpointRow: row.checkpointRow,
    validationErrors: Array.isArray(row.validationErrors) ? row.validationErrors : [],
    errorMessage: row.errorMessage,
    attempts: row.attempts,
    propertyId: row.propertyId,
    bankAccountId: row.bankAccountId,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    completedAt: row.completedAt,
  };
}
