/**
 * API bootstrap.
 *
 * Order matters here:
 *
 *  1. `reflect-metadata` before anything decorated is loaded.
 *  2. The raw-body capture for the webhook route is registered before the JSON
 *     parser, because a signature is computed over the bytes that were sent,
 *     not over a re-serialisation of the parsed object.
 *  3. Shutdown hooks are enabled so SIGTERM from a container runtime drains
 *     in-flight requests and closes the database pool rather than dropping them.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { apiConfig, apiLogger } from './core.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Requests are logged through pino with a correlation id; Nest's own
    // logger would duplicate that in a different format.
    logger: ['error', 'warn'],
    bodyParser: false,
  });

  // The webhook route needs the exact bytes the provider signed.
  app.use('/webhooks', express.text({ type: '*/*', limit: '2mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  app.enableCors({
    origin: apiConfig.http.webOrigin,
    // Sessions travel in a cookie, so the browser must be allowed to send it.
    credentials: true,
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-correlation-id', 'x-apollo-operation-name'],
    exposedHeaders: ['x-correlation-id'],
  });

  app.set('trust proxy', 1);
  app.enableShutdownHooks();

  await app.listen(apiConfig.http.port, apiConfig.http.host);

  apiLogger.info(
    {
      port: apiConfig.http.port,
      host: apiConfig.http.host,
      graphqlPath: apiConfig.http.graphqlPath,
      env: apiConfig.env,
      aiProvider: apiConfig.ai.provider,
      bankProvider: apiConfig.bank.provider,
    },
    'Rentwell API listening',
  );
}

bootstrap().catch((error: unknown) => {
  apiLogger.error({ err: error }, 'API failed to start');
  process.exitCode = 1;
});
