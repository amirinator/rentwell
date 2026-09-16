import { Module } from '@nestjs/common';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { ImportsService } from './imports.service';
import { TransactionsService } from './transactions.service';
import {
  ImportResolver,
  ImportRowResolver,
  IngestionMutationsResolver,
  TransactionResolver,
} from './ingestion.resolver';

@Module({
  imports: [ReconciliationModule],
  providers: [
    ImportsService,
    TransactionsService,
    ImportResolver,
    ImportRowResolver,
    TransactionResolver,
    IngestionMutationsResolver,
  ],
  exports: [ImportsService, TransactionsService],
})
export class IngestionModule {}
