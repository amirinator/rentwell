import { Module } from '@nestjs/common';
import { ChargesService } from './charges.service';
import {
  ChargeMutationsResolver,
  ChargeResolver,
  ProposedChargeResolver,
} from './receivables.resolver';

@Module({
  providers: [ChargesService, ChargeResolver, ChargeMutationsResolver, ProposedChargeResolver],
  exports: [ChargesService],
})
export class ReceivablesModule {}
