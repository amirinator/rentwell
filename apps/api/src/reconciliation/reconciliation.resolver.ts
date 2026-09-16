import { Args, Context, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
  DomainError,
  periodEnd,
  type ExceptionResolution,
  type ExceptionSeverity,
} from '@rentwell/domain';
import {
  clampPageSize,
  type ApproveAllocationsInput,
  type ExceptionFilter,
  type ReverseAllocationInput,
} from '@rentwell/graphql';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePropertyScope } from '../common/guards';
import {
  andWhere,
  buildConnection,
  decodeOptionalCursor,
  encodeCursor,
} from '../common/pagination';
import { toGqlMoney } from '../common/money';
import {
  allocationView,
  chargeView,
  exceptionView,
  memberView,
  propertyView,
  transactionView,
  type ChargeRowForView,
  type PropertyRowForView,
  type TransactionRowForView,
} from '../common/view';
import type { GqlContext } from '../common/context';
import { AllocationsService } from './allocations.service';
import { ExceptionsService } from './exceptions.service';
import { SuggestionsService } from './suggestions.service';
import { centsFromDb } from '@rentwell/database';

@Resolver('MatchSuggestion')
export class SuggestionResolver {
  constructor(
    private readonly suggestions: SuggestionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Query('matchSuggestions')
  async matchSuggestions(@Args('transactionId') transactionId: string, @Context() ctx: GqlContext) {
    const rows = await this.suggestions.listForTransaction(ctx, transactionId);
    return rows.map((row) => ({
      id: row.id,
      strategy: row.strategy,
      status: row.status,
      // Line records carry their charge id; the charge itself is a field
      // resolver so a list of suggestions does not fetch every charge twice.
      lines: row.lines.map((line) => ({
        chargeId: line.chargeId,
        amount: toGqlMoney(line.amount.cents, line.amount.currency),
      })),
      totalAmount: toGqlMoney(row.totalAllocated.cents, row.totalAllocated.currency),
      remainder: toGqlMoney(row.unappliedRemainder.cents, row.unappliedRemainder.currency),
      score: row.score,
      scoreComponents: row.scoreComponents,
      evidence: row.evidence.map((item) => ({
        kind: item.kind,
        label: item.label,
        recordIds: [...item.recordIds],
        contribution: item.contribution,
      })),
      warnings: [...row.warnings],
      ruleVersion: row.ruleVersion,
      generatedAt: row.generatedAt,
      isStale: row.isStale,
    }));
  }

  @Mutation('regenerateSuggestions')
  async regenerateSuggestions(
    @Args('input') input: { transactionId: string },
    @Context() ctx: GqlContext,
  ) {
    await this.suggestions.regenerate(ctx, input.transactionId);
    return this.matchSuggestions(input.transactionId, ctx);
  }
}

@Resolver('SuggestedAllocation')
export class SuggestedAllocationResolver {
  @ResolveField('charge')
  async charge(@Parent() line: { chargeId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.charge.load(line.chargeId);
    if (!row) return null;
    const charge = row as unknown as ChargeRowForView;
    return chargeView(charge, periodEnd(charge.period));
  }
}

@Resolver('ReconciliationException')
export class ExceptionResolver {
  constructor(
    private readonly exceptions: ExceptionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Query('exceptions')
  async list(
    @Args('filter') filter: ExceptionFilter,
    @Args('first') first: number | null,
    @Args('after') after: string | null,
    @Context() ctx: GqlContext,
  ) {
    const access = this.exceptions.requireReadAccess(ctx);
    const scope = resolvePropertyScope(access, filter.propertyIds);
    const limit = clampPageSize(first);
    const cursor = decodeOptionalCursor(after);

    const baseWhere = andWhere(
      { organizationId: access.organizationId },
      scope === null ? undefined : { propertyId: { in: scope } },
      filter.statuses && filter.statuses.length > 0
        ? { status: { in: filter.statuses } }
        : undefined,
      filter.categories && filter.categories.length > 0
        ? { category: { in: filter.categories } }
        : undefined,
      filter.severities && filter.severities.length > 0
        ? { severity: { in: filter.severities } }
        : undefined,
      filter.assignedToUserId ? { assignedToUserId: filter.assignedToUserId } : undefined,
      filter.period ? { period: filter.period } : undefined,
      filter.onlyBlocking ? { isBlocking: true } : undefined,
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
      this.prisma.client.reconciliationException.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.prisma.client.reconciliationException.count({ where: baseWhere }),
    ]);

    return buildConnection({
      rows,
      limit,
      totalCount,
      hasPreviousPage: cursor !== null,
      cursorFor: (row) => encodeCursor(row.createdAt, row.id),
      toNode: (row) => exceptionView(row),
    });
  }

  @Query('exception')
  async one(@Args('id') id: string, @Context() ctx: GqlContext) {
    const access = this.exceptions.requireReadAccess(ctx);
    const row = await this.prisma.client.reconciliationException.findFirst({
      where: { id, organizationId: access.organizationId },
    });
    if (!row) throw new DomainError('NOT_FOUND', 'Exception not found', { details: { id } });

    const scope = resolvePropertyScope(access, null);
    if (scope !== null && !scope.includes(row.propertyId)) {
      throw new DomainError('PROPERTY_NOT_ASSIGNED', 'You are not assigned to this property');
    }
    return exceptionView(row);
  }

  @ResolveField('property')
  async property(@Parent() exception: { propertyId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.property.load(exception.propertyId);
    return row ? propertyView(row as unknown as PropertyRowForView) : null;
  }

  @ResolveField('transaction')
  async transaction(
    @Parent() exception: { transactionId: string | null },
    @Context() ctx: GqlContext,
  ) {
    if (!exception.transactionId) return null;
    const row = await ctx.loaders.transaction.load(exception.transactionId);
    return row ? transactionView(row as unknown as TransactionRowForView) : null;
  }

  @ResolveField('tenant')
  async tenant(@Parent() exception: { tenantId: string | null }, @Context() ctx: GqlContext) {
    return exception.tenantId ? ctx.loaders.tenant.load(exception.tenantId) : null;
  }

  @ResolveField('assignedTo')
  async assignedTo(
    @Parent() exception: { assignedToUserId: string | null },
    @Context() ctx: GqlContext,
  ) {
    return exception.assignedToUserId ? this.member(ctx, exception.assignedToUserId) : null;
  }

  @ResolveField('resolvedBy')
  async resolvedBy(
    @Parent() exception: { resolvedByUserId: string | null },
    @Context() ctx: GqlContext,
  ) {
    return exception.resolvedByUserId ? this.member(ctx, exception.resolvedByUserId) : null;
  }

  @ResolveField('comments')
  async comments(@Parent() exception: { id: string }) {
    const rows = await this.prisma.client.exceptionComment.findMany({
      where: { exceptionId: exception.id },
      include: { author: { select: { displayName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      body: row.body,
      authorName: row.author.displayName,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Charges the payment could plausibly settle, for the investigation panel.
   *
   * Deliberately the same candidate set the matching engine considers, so the
   * accountant sees what the engine saw rather than a differently-filtered list
   * that makes the engine look wrong.
   */
  @ResolveField('candidateCharges')
  async candidateCharges(
    @Parent() exception: { propertyId: string; tenantId: string | null; period: string },
    @Context() ctx: GqlContext,
  ) {
    const access = this.exceptions.requireReadAccess(ctx);
    const rows = await this.prisma.client.charge.findMany({
      where: {
        organizationId: access.organizationId,
        propertyId: exception.propertyId,
        openCents: { gt: 0 },
        ...(exception.tenantId ? { tenantId: exception.tenantId } : {}),
      },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: 25,
    });
    return rows.map((row) =>
      chargeView(row as unknown as ChargeRowForView, periodEnd(exception.period)),
    );
  }

  @ResolveField('assistantRuns')
  async assistantRuns(@Parent() exception: { id: string }) {
    const rows = await this.prisma.client.assistantRun.findMany({
      where: { exceptionId: exception.id },
      include: { toolCalls: { orderBy: { sequence: 'asc' } } },
      orderBy: { startedAt: 'desc' },
      take: 10,
    });
    return rows.map((row) => assistantRunView(row));
  }

  private async member(ctx: GqlContext, userId: string) {
    return memberView(await ctx.loaders.user.load(userId), userId);
  }
}

@Resolver('Allocation')
export class AllocationResolver {
  constructor(private readonly prisma: PrismaService) {}

  @ResolveField('charge')
  async charge(@Parent() allocation: { chargeId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.charge.load(allocation.chargeId);
    if (!row) return null;
    const charge = row as unknown as ChargeRowForView;
    return chargeView(charge, periodEnd(charge.period));
  }

  @ResolveField('transaction')
  async transaction(@Parent() allocation: { transactionId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.transaction.load(allocation.transactionId);
    return row ? transactionView(row as unknown as TransactionRowForView) : null;
  }

  @ResolveField('reversal')
  async reversal(@Parent() allocation: { id: string }) {
    const row = await this.prisma.client.allocationReversal.findUnique({
      where: { allocationId: allocation.id },
    });
    if (!row) return null;
    return {
      id: row.id,
      amount: toGqlMoney(centsFromDb(row.amountCents), 'USD'),
      reason: row.reason,
      postingDate: row.postingDate.toISOString().slice(0, 10),
      createdAt: row.createdAt,
    };
  }
}

@Resolver('Mutation')
export class ReconciliationMutationsResolver {
  constructor(
    private readonly allocations: AllocationsService,
    private readonly exceptions: ExceptionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Mutation('approveAllocations')
  async approveAllocations(
    @Args('input') input: ApproveAllocationsInput,
    @Context() ctx: GqlContext,
  ) {
    const result = await this.allocations.approve(ctx, input);

    const [transaction, allocations, exception] = await Promise.all([
      this.prisma.client.bankTransaction.findUniqueOrThrow({
        where: { id: result.transactionId },
      }),
      this.prisma.client.allocation.findMany({ where: { id: { in: result.allocationIds } } }),
      result.exceptionId
        ? this.prisma.client.reconciliationException.findUnique({
            where: { id: result.exceptionId },
          })
        : Promise.resolve(null),
    ]);

    return {
      transaction: transactionView(transaction as unknown as TransactionRowForView),
      allocations: allocations.map((row) => allocationView(row)),
      totalAllocated: toGqlMoney(result.totalAllocatedCents, result.currency),
      remainingUnapplied: toGqlMoney(result.remainingUnappliedCents, result.currency),
      exception: exception ? exceptionView(exception) : null,
    };
  }

  @Mutation('reverseAllocation')
  async reverseAllocation(
    @Args('input') input: ReverseAllocationInput,
    @Context() ctx: GqlContext,
  ) {
    const result = await this.allocations.reverse(ctx, input);

    const [allocation, transaction, charge] = await Promise.all([
      this.prisma.client.allocation.findUniqueOrThrow({ where: { id: result.allocationId } }),
      this.prisma.client.bankTransaction.findUniqueOrThrow({ where: { id: result.transactionId } }),
      this.prisma.client.charge.findUniqueOrThrow({ where: { id: result.chargeId } }),
    ]);

    return {
      allocation: allocationView(allocation),
      transaction: transactionView(transaction as unknown as TransactionRowForView),
      charge: chargeView(charge as unknown as ChargeRowForView, periodEnd(charge.period)),
    };
  }

  @Mutation('assignException')
  async assignException(
    @Args('input')
    input: {
      exceptionId: string;
      assignedToUserId?: string | null;
      severity?: ExceptionSeverity | null;
      expectedVersion: number;
    },
    @Context() ctx: GqlContext,
  ) {
    const id = await this.exceptions.assign(ctx, input);
    return exceptionView(
      await this.prisma.client.reconciliationException.findUniqueOrThrow({ where: { id } }),
    );
  }

  @Mutation('resolveException')
  async resolveException(
    @Args('input')
    input: {
      exceptionId: string;
      resolution: ExceptionResolution;
      reason: string;
      expectedVersion: number;
    },
    @Context() ctx: GqlContext,
  ) {
    const id = await this.exceptions.resolve(ctx, input);
    return exceptionView(
      await this.prisma.client.reconciliationException.findUniqueOrThrow({ where: { id } }),
    );
  }

  @Mutation('reopenException')
  async reopenException(
    @Args('input') input: { exceptionId: string; reason: string; expectedVersion: number },
    @Context() ctx: GqlContext,
  ) {
    const id = await this.exceptions.reopen(ctx, input);
    return exceptionView(
      await this.prisma.client.reconciliationException.findUniqueOrThrow({ where: { id } }),
    );
  }

  @Mutation('commentOnException')
  async commentOnException(
    @Args('input') input: { exceptionId: string; body: string },
    @Context() ctx: GqlContext,
  ) {
    const id = await this.exceptions.comment(ctx, input.exceptionId, input.body);
    return exceptionView(
      await this.prisma.client.reconciliationException.findUniqueOrThrow({ where: { id } }),
    );
  }
}

/** Shared shape for a stored assistant run, used in two resolvers. */
export function assistantRunView(row: {
  id: string;
  status: string;
  provider: string;
  model: string;
  promptVersion: string;
  output: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  startedAt: Date;
  completedAt: Date | null;
  toolCalls?: {
    sequence: number;
    toolName: string;
    allowed: boolean;
    denialReason: string | null;
    resultSummary: string | null;
  }[];
}) {
  return {
    id: row.id,
    status: row.status,
    provider: row.provider,
    model: row.model,
    promptVersion: row.promptVersion,
    analysis: row.output ?? null,
    toolCalls: (row.toolCalls ?? []).map((call) => ({
      sequence: call.sequence,
      toolName: call.toolName,
      allowed: call.allowed,
      denialReason: call.denialReason,
      resultSummary: call.resultSummary,
    })),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    durationMs: row.durationMs,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}
