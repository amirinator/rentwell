/**
 * Suggestion regeneration.
 *
 * Runs whenever a payment's balances move: on ingestion, after an allocation is
 * reversed, and after a payment is reversed. Regenerating is idempotent — the
 * engine is a pure function of the current records, and storage upserts on the
 * suggestion fingerprint — so a repeated delivery costs one recomputation and
 * changes nothing.
 */

import { Inject, Injectable } from '@nestjs/common';
import { isDomainError, systemContext } from '@rentwell/domain';
import type { Logger } from '@rentwell/observability';
import { PrismaService, SuggestionsService } from '@rentwell/api/modules';
import { WORKER_LOGGER } from '../tokens';
import type { SuggestionJobData } from '../queues';

@Injectable()
export class SuggestionProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly suggestions: SuggestionsService,
    @Inject(WORKER_LOGGER) private readonly logger: Logger,
  ) {}

  async process(data: SuggestionJobData): Promise<number> {
    const access = systemContext(data.organizationId);

    try {
      const result = await this.prisma.run((tx) =>
        this.suggestions.generateFor(tx, access, data.transactionId, data.correlationId),
      );

      this.logger.debug(
        { transactionId: data.transactionId, count: result.length },
        'Regenerated suggestions',
      );
      return result.length;
    } catch (error) {
      // A payment deleted between enqueue and processing is not worth
      // retrying; anything else is.
      if (isDomainError(error) && error.code === 'NOT_FOUND') {
        this.logger.warn({ transactionId: data.transactionId }, 'Payment no longer exists');
        return 0;
      }
      throw error;
    }
  }
}
