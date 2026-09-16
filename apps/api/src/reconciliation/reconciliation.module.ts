import { Module } from '@nestjs/common';
import { AllocationsService } from './allocations.service';
import { ExceptionsService } from './exceptions.service';
import { SuggestionsService } from './suggestions.service';
import {
  AllocationResolver,
  ExceptionResolver,
  ReconciliationMutationsResolver,
  SuggestedAllocationResolver,
  SuggestionResolver,
} from './reconciliation.resolver';

/**
 * ExceptionsService and SuggestionsService are exported because the ingestion
 * path needs them: a payment that arrives unmatched raises an exception in the
 * same transaction that creates it.
 */
@Module({
  providers: [
    AllocationsService,
    ExceptionsService,
    SuggestionsService,
    SuggestionResolver,
    SuggestedAllocationResolver,
    ExceptionResolver,
    AllocationResolver,
    ReconciliationMutationsResolver,
  ],
  exports: [AllocationsService, ExceptionsService, SuggestionsService, SuggestionResolver],
})
export class ReconciliationModule {}
