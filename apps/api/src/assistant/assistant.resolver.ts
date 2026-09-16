import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { GqlContext } from '../common/context';
import { assistantRunView } from '../reconciliation/reconciliation.resolver';
import { AssistantService } from './assistant.service';

@Resolver('AssistantRun')
export class AssistantResolver {
  constructor(private readonly assistant: AssistantService) {}

  @Query('assistantRun')
  async assistantRun(@Args('id') id: string, @Context() ctx: GqlContext) {
    return assistantRunView(await this.assistant.getRun(ctx, id));
  }

  /**
   * Starts an analysis and returns the completed run.
   *
   * A failed run is returned as a record with an error code rather than raised
   * as a GraphQL error: the exception workspace stays usable, and the
   * accountant sees that the assistant could not help this time instead of an
   * error banner over their investigation.
   */
  @Mutation('analyzeException')
  async analyzeException(@Args('exceptionId') exceptionId: string, @Context() ctx: GqlContext) {
    const result = await this.assistant.analyze(ctx, exceptionId);
    // Read the persisted run back rather than assembling a response from the
    // in-memory result: the stored row is what an auditor will see, and the two
    // must not be able to differ.
    return assistantRunView(await this.assistant.getRun(ctx, result.runId));
  }
}
