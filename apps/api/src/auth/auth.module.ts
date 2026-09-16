import { Module } from '@nestjs/common';
import { AuthResolver } from './auth.resolver';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

/**
 * SessionService is exported because the GraphQL context factory needs it to
 * resolve the principal before any resolver runs.
 */
@Module({
  providers: [AuthService, SessionService, AuthResolver],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
