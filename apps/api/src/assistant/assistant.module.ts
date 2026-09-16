import { Module } from '@nestjs/common';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { AssistantService } from './assistant.service';
import { AssistantResolver } from './assistant.resolver';

@Module({
  imports: [ReconciliationModule],
  providers: [AssistantService, AssistantResolver],
  exports: [AssistantService],
})
export class AssistantModule {}
