import { Module } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import {
  ChargeScheduleResolver,
  LeaseResolver,
  PropertyResolver,
  TenantResolver,
  UnitResolver,
} from './portfolio.resolver';

@Module({
  providers: [
    PortfolioService,
    PropertyResolver,
    UnitResolver,
    TenantResolver,
    LeaseResolver,
    ChargeScheduleResolver,
  ],
  exports: [PortfolioService],
})
export class PortfolioModule {}
