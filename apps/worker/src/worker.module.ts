/**
 * Worker composition.
 *
 * The worker reuses the API's feature modules rather than reimplementing them,
 * which is why `@rentwell/api/modules` exists: importing the package root would
 * start an HTTP server. Sharing the modules means the reconciliation rules a
 * background job applies are the same code the interactive path uses, not a
 * second copy that can drift from it.
 */

import { Module } from '@nestjs/common';
import {
  IngestionModule,
  PrismaModule,
  ReceivablesModule,
  ReconciliationModule,
} from '@rentwell/api/modules';
import { WorkerCoreModule } from './worker-core.module';
import { TransactionIngestService } from './ingest/transaction-ingest.service';
import { ImportProcessor } from './processors/import.processor';
import { ProviderSyncProcessor } from './processors/provider-sync.processor';
import { SuggestionProcessor } from './processors/suggestion.processor';
import { WebhookProcessor } from './processors/webhook.processor';
import { MaintenanceProcessor } from './processors/maintenance.processor';
import { OutboxDispatcher } from './processors/outbox.dispatcher';

@Module({
  imports: [
    WorkerCoreModule,
    PrismaModule,
    ReconciliationModule,
    IngestionModule,
    ReceivablesModule,
  ],
  providers: [
    TransactionIngestService,
    ImportProcessor,
    ProviderSyncProcessor,
    SuggestionProcessor,
    WebhookProcessor,
    MaintenanceProcessor,
    OutboxDispatcher,
  ],
  exports: [
    ImportProcessor,
    ProviderSyncProcessor,
    SuggestionProcessor,
    WebhookProcessor,
    MaintenanceProcessor,
    OutboxDispatcher,
  ],
})
export class WorkerModule {}
