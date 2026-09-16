import { Module } from '@nestjs/common';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { CloseService } from './close.service';
import {
  AccountingPeriodResolver,
  CloseMutationsResolver,
  CloseReadinessResolver,
  CloseSnapshotResolver,
} from './close.resolver';

@Module({
  imports: [ReconciliationModule],
  providers: [
    CloseService,
    CloseReadinessResolver,
    CloseSnapshotResolver,
    AccountingPeriodResolver,
    CloseMutationsResolver,
  ],
  exports: [CloseService],
})
export class CloseModule {}
