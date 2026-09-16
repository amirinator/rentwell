/**
 * Worker singletons, provided globally.
 *
 * Global matters here for a specific reason: the worker reuses the API's
 * feature modules, and those modules inject the API's tokens (configuration,
 * logger, clock, object store). A provider declared in an importing module is
 * not visible to the module it imports, so satisfying those tokens requires a
 * global module rather than a local provider list.
 *
 * This is also where the worker's Redis connection and queues are created, once
 * per process.
 */

import { Global, Module } from '@nestjs/common';
import { ObjectStore } from '@rentwell/integrations';
import { createLogger, type Logger } from '@rentwell/observability';
import {
  API_CONFIG,
  CLOCK,
  LOGGER,
  OBJECT_STORE as API_OBJECT_STORE,
  systemClock,
} from '@rentwell/api/modules';
import { OBJECT_STORE, QUEUES, REDIS, WORKER_CONFIG, WORKER_LOGGER } from './tokens';
import { loadWorkerConfig, type WorkerConfig } from './config';
import { createQueues, createRedisConnection, type QueueSet } from './queues';

export const workerConfig: WorkerConfig = loadWorkerConfig();

export const workerLogger: Logger = createLogger({
  serviceName: 'rentwell-worker',
  level: workerConfig.logLevel,
  pretty: !workerConfig.isProduction,
  environment: workerConfig.env,
});

export const objectStore = new ObjectStore({
  endpoint: workerConfig.storage.endpoint,
  region: workerConfig.storage.region,
  bucket: workerConfig.storage.bucket,
  accessKeyId: workerConfig.storage.accessKeyId,
  secretAccessKey: workerConfig.storage.secretAccessKey,
  forcePathStyle: workerConfig.storage.forcePathStyle,
  signedUrlTtlSeconds: workerConfig.storage.signedUrlTtlSeconds,
});

export const redisConnection = createRedisConnection(workerConfig.redis.url);

export const queues: QueueSet = createQueues(redisConnection, workerConfig.redis.queuePrefix);

@Global()
@Module({
  providers: [
    // The API's tokens, so its services resolve inside the worker exactly as
    // they do inside the API process.
    { provide: API_CONFIG, useValue: workerConfig },
    { provide: LOGGER, useValue: workerLogger },
    { provide: CLOCK, useValue: systemClock },
    { provide: API_OBJECT_STORE, useValue: objectStore },

    { provide: WORKER_CONFIG, useValue: workerConfig },
    { provide: WORKER_LOGGER, useValue: workerLogger },
    { provide: OBJECT_STORE, useValue: objectStore },
    { provide: QUEUES, useValue: queues },
    { provide: REDIS, useValue: redisConnection },
  ],
  exports: [
    API_CONFIG,
    LOGGER,
    CLOCK,
    API_OBJECT_STORE,
    WORKER_CONFIG,
    WORKER_LOGGER,
    OBJECT_STORE,
    QUEUES,
    REDIS,
  ],
})
export class WorkerCoreModule {}
