import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import {
  AuditResolver,
  DashboardResolver,
  PropertyCloseStatusResolver,
} from './dashboard.resolver';

@Module({
  providers: [DashboardService, DashboardResolver, PropertyCloseStatusResolver, AuditResolver],
  exports: [DashboardService],
})
export class DashboardModule {}
