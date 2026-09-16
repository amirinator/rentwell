import { Args, Context, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import type { PeriodKey } from '@rentwell/domain';
import type { JournalFilter } from '@rentwell/graphql';
import { toGqlMoney } from '../common/money';
import { journalEntryView, propertyView, type PropertyRowForView } from '../common/view';
import type { GqlContext } from '../common/context';
import { JournalService } from './journal.service';

@Resolver('JournalEntry')
export class JournalResolver {
  constructor(private readonly journal: JournalService) {}

  @Query('journalEntries')
  async journalEntries(
    @Args('filter') filter: JournalFilter,
    @Args('first') first: number | null,
    @Args('after') after: string | null,
    @Context() ctx: GqlContext,
  ) {
    const result = await this.journal.listEntries(ctx, filter, { first, after });

    return {
      edges: result.edges.map((edge) => ({
        cursor: edge.cursor,
        node: journalEntryView(edge.node),
      })),
      pageInfo: result.pageInfo,
      totalCount: result.totalCount,
      // Zero over a complete set. A non-zero value here means the subledger is
      // inconsistent, which the close checklist treats as a blocker.
      netDebitMinusCredit: toGqlMoney(result.netDebitMinusCreditCents, result.currency),
    };
  }

  @Query('accountBalances')
  async accountBalances(
    @Args('propertyId') propertyId: string,
    @Args('period') period: PeriodKey,
    @Context() ctx: GqlContext,
  ) {
    const rows = await this.journal.accountBalances(ctx, propertyId, period);
    return rows.map((row) => ({
      accountCode: row.accountCode,
      balance: toGqlMoney(row.balanceCents, row.currency),
      debitTotal: toGqlMoney(row.debitCents, row.currency),
      creditTotal: toGqlMoney(row.creditCents, row.currency),
    }));
  }

  @ResolveField('property')
  async property(@Parent() entry: { propertyId: string }, @Context() ctx: GqlContext) {
    const row = await ctx.loaders.property.load(entry.propertyId);
    return row ? propertyView(row as unknown as PropertyRowForView) : null;
  }
}
