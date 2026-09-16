import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';
import { JournalResolver } from './subledger.resolver';

@Module({
  providers: [JournalService, JournalResolver],
  exports: [JournalService],
})
export class SubledgerModule {}
