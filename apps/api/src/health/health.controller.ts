/**
 * Health, readiness and the provider webhook endpoint.
 *
 * These are the only non-GraphQL HTTP routes. They exist because an
 * orchestrator and a payment provider both need plain HTTP, and neither should
 * have to speak GraphQL to reach us.
 */

import { Controller, Get, Headers, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError, isDomainError } from '@rentwell/domain';
import { ProviderError, type BankingProvider } from '@rentwell/integrations';
import {
  healthStatusCode,
  runHealthChecks,
  type HealthCheck,
  type Logger,
} from '@rentwell/observability';
import { PrismaService } from '../prisma/prisma.service';
import { BANKING_PROVIDER, LOGGER, OBJECT_STORE } from '../common/tokens';
import type { ObjectStore } from '@rentwell/integrations';
import { httpStatusForCode } from '../common/errors';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORE) private readonly storage: ObjectStore,
    @Inject(BANKING_PROVIDER) private readonly bank: BankingProvider,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Liveness. Checks nothing external on purpose: a database blip must not
   * cause an orchestrator to restart a working process and deepen the outage.
   */
  @Get('healthz')
  liveness() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /**
   * Readiness. Checks every dependency needed to serve a request, so a process
   * that cannot reach the database is removed from the load balancer instead of
   * returning errors.
   */
  @Get('readyz')
  async readiness(@Res() res: Response) {
    const checks: HealthCheck[] = [
      { name: 'database', run: () => this.prisma.healthCheck() },
      // Object storage is only needed for imports, so it degrades rather than
      // fails: the rest of the application is still usable without it.
      { name: 'object-storage', run: () => this.storage.healthCheck(), optional: true },
    ];

    const report = await runHealthChecks(checks);
    res.status(healthStatusCode(report)).json(report);
  }

  /**
   * Provider webhook.
   *
   * The signature is verified before the body is parsed as anything meaningful,
   * so an unsigned or forged delivery is rejected without reaching the domain.
   * The event is stored and processed asynchronously; the provider gets an
   * immediate 202 so a slow database does not cause it to retry a delivery we
   * already hold.
   */
  @Post('webhooks/bank')
  @HttpCode(202)
  async webhook(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('x-signature') signature: string | undefined,
  ) {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});

    try {
      const event = this.bank.parseWebhook(rawBody, signature);

      // The provider name alone does not identify a tenant: IntegrationConnection
      // is unique on (organizationId, provider, label), so several organizations
      // may hold a connection to the same provider. Taking the first match would
      // attribute the delivery to whichever row the database happened to return,
      // and the worker derives its whole access context from this connection —
      // a reversal would then void a payment in someone else's books.
      //
      // The signed payload names the account it concerns, so resolve the
      // connection through that instead. `providerAccountId` is assigned by the
      // provider and is therefore only unique within one provider, so the
      // connection's provider is part of the lookup.
      const account = await this.prisma.client.bankAccount.findFirst({
        where: {
          providerAccountId: event.transaction.providerAccountId,
          connection: { is: { provider: this.bank.name } },
        },
        select: { connectionId: true },
      });
      if (!account?.connectionId) {
        throw new DomainError(
          'NOT_FOUND',
          'No integration connection matches the account in this delivery',
          {
            details: { providerAccountId: event.transaction.providerAccountId },
          },
        );
      }
      const connectionId = account.connectionId;

      // Stored before processing and keyed on the provider's own event id, so
      // a redelivery is recognised and dropped rather than applied twice.
      await this.prisma.client.providerWebhookEvent.upsert({
        where: { connectionId_eventId: { connectionId, eventId: event.eventId } },
        create: {
          connectionId,
          eventId: event.eventId,
          eventType: event.eventType,
          payload: JSON.parse(rawBody) as object,
        },
        update: {},
      });

      res.status(202).json({ accepted: true, eventId: event.eventId });
    } catch (error) {
      if (error instanceof ProviderError) {
        this.logger.warn({ err: error }, 'Rejected a provider webhook delivery');
        res.status(401).json({ error: 'signature verification failed' });
        return;
      }
      if (isDomainError(error)) {
        res.status(httpStatusForCode(error.code)).json({ error: error.code });
        return;
      }
      this.logger.error({ err: error }, 'Provider webhook handling failed');
      res.status(500).json({ error: 'internal error' });
    }
  }
}
