/**
 * Application composition.
 *
 * Feature modules are thin: they wire providers, not logic. The interesting
 * decision here is the GraphQL context factory, which is the single place
 * authentication happens — once per request, before any resolver runs — so no
 * resolver can accidentally skip it.
 */

import { Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import type { Request, Response } from 'express';
import { loadTypeDefs, scalarResolvers } from '@rentwell/graphql';
import {
  CORRELATION_HEADER,
  childLogger,
  getMetrics,
  resolveCorrelationId,
  startTracing,
  type TracingHandle,
} from '@rentwell/observability';
import { CoreModule, apiConfig, apiLogger } from './core.module';
import { buildErrorFormatter } from './common/errors';
import { createLoaders } from './common/loaders';
import { complexityPlugin } from './common/complexity.plugin';
import type { GqlContext } from './common/context';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { AuthModule } from './auth/auth.module';
import { SessionService } from './auth/session.service';
import { PortfolioModule } from './portfolio/portfolio.module';
import { ReceivablesModule } from './receivables/receivables.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { SubledgerModule } from './subledger/subledger.module';
import { CloseModule } from './close/close.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AssistantModule } from './assistant/assistant.module';
import { HealthModule } from './health/health.module';

/**
 * True when the request body contains a mutation.
 *
 * Read from the operation text rather than the HTTP method, because GraphQL
 * sends everything over POST. A query therefore does not need a CSRF token; a
 * mutation always does.
 */
export function bodyContainsMutation(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const query = (body as { query?: unknown }).query;
  if (typeof query !== 'string') return false;
  // Matches `mutation Name(...)`, `mutation {`, and a mutation after a fragment.
  return /(^|[\s}])mutation\b/.test(query);
}

/** Placeholder organization id for an anonymous request's loaders. */
const NO_ORGANIZATION = '00000000-0000-0000-0000-000000000000';

@Module({
  imports: [
    CoreModule,
    PrismaModule,
    AuthModule,
    PortfolioModule,
    ReceivablesModule,
    IngestionModule,
    ReconciliationModule,
    SubledgerModule,
    CloseModule,
    DashboardModule,
    AssistantModule,
    HealthModule,

    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [AuthModule, PrismaModule],
      inject: [SessionService, PrismaService],
      useFactory: (sessions: SessionService, prisma: PrismaService): ApolloDriverConfig => ({
        typeDefs: loadTypeDefs(),
        resolvers: { ...scalarResolvers },
        path: apiConfig.http.graphqlPath,
        introspection: apiConfig.graphql.introspection,
        playground: false,
        formatError: buildErrorFormatter(apiLogger, apiConfig.isProduction),
        plugins: [
          complexityPlugin({
            maxComplexity: apiConfig.graphql.maxComplexity,
            maxDepth: apiConfig.graphql.maxDepth,
            logger: apiLogger,
          }),
          {
            async requestDidStart() {
              const startedAt = Date.now();
              return {
                async willSendResponse(requestContext) {
                  const operation = requestContext.operationName ?? 'anonymous';
                  getMetrics().apiLatency.record(Date.now() - startedAt, { operation });
                  if ((requestContext.errors?.length ?? 0) > 0) {
                    getMetrics().apiErrors.add(1, { operation });
                  }
                },
              };
            },
          },
        ],

        context: async ({ req, res }: { req: Request; res: Response }): Promise<GqlContext> => {
          const correlationId = resolveCorrelationId(req.headers[CORRELATION_HEADER]);
          res.setHeader(CORRELATION_HEADER, correlationId);

          const session = await sessions.resolve(req).catch((error: unknown) => {
            // A failed session lookup makes the request anonymous rather than
            // failing it: the guards will produce a clean UNAUTHENTICATED.
            apiLogger.warn({ err: error, correlationId }, 'Could not resolve the session');
            return null;
          });

          // CSRF is checked here, before any resolver runs, so no mutation can
          // be reached without it.
          if (session && bodyContainsMutation(req.body)) {
            sessions.assertCsrf(req, session.csrfToken);
          }

          return {
            access: session?.access ?? null,
            sessionId: session?.sessionId ?? null,
            csrfToken: session?.csrfToken ?? null,
            correlationId,
            logger: childLogger(apiLogger, {
              correlationId,
              userId: session?.access.userId,
              organizationId: session?.access.organizationId,
            }),
            // Loaders are bound to the viewer's organization, so an anonymous
            // request gets loaders that can never return a row.
            loaders: createLoaders(
              prisma.client,
              session?.access.organizationId ?? NO_ORGANIZATION,
            ),
            req,
            res,
            startedAt: Date.now(),
          };
        },
      }),
    }),
  ],
})
export class AppModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private tracing: TracingHandle | null = null;

  async onApplicationBootstrap(): Promise<void> {
    this.tracing = await startTracing({
      enabled: apiConfig.otel.enabled,
      serviceName: apiConfig.otel.serviceName,
      otlpEndpoint: apiConfig.otel.endpoint,
      environment: apiConfig.env,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.tracing?.shutdown();
  }
}
