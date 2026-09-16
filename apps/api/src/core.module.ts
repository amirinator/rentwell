/**
 * Cross-cutting singletons.
 *
 * Global so every feature module can inject configuration, the logger, the
 * clock and the external adapters without re-declaring them. They are provided
 * through tokens rather than reached through module-level singletons, so a test
 * can replace any of them — particularly the clock, which financial tests need
 * to control.
 */

import { Global, Module } from '@nestjs/common';
import { DomainError } from '@rentwell/domain';
import { ObjectStore, createBankingProvider } from '@rentwell/integrations';
import { createLogger, type Logger } from '@rentwell/observability';
import { API_CONFIG, loadConfig, type ApiConfig } from './config/configuration';
import { ASSISTANT_PROVIDER, BANKING_PROVIDER, CLOCK, LOGGER, OBJECT_STORE } from './common/tokens';
import { systemClock } from './common/clock';
import { AnthropicAssistantProvider, MockAssistantProvider } from './assistant/provider';

/**
 * Configuration and the logger are resolved once at module load rather than
 * lazily, so a misconfigured environment fails before the server binds a port
 * instead of on the first request that needs the missing value.
 */
export const apiConfig: ApiConfig = loadConfig();

export const apiLogger: Logger = createLogger({
  serviceName: apiConfig.otel.serviceName,
  level: apiConfig.logLevel,
  pretty: !apiConfig.isProduction,
  environment: apiConfig.env,
});

@Global()
@Module({
  providers: [
    { provide: API_CONFIG, useValue: apiConfig },
    { provide: LOGGER, useValue: apiLogger },
    { provide: CLOCK, useValue: systemClock },
    {
      provide: OBJECT_STORE,
      useFactory: (config: ApiConfig) =>
        new ObjectStore({
          endpoint: config.storage.endpoint,
          region: config.storage.region,
          bucket: config.storage.bucket,
          accessKeyId: config.storage.accessKeyId,
          secretAccessKey: config.storage.secretAccessKey,
          forcePathStyle: config.storage.forcePathStyle,
          signedUrlTtlSeconds: config.storage.signedUrlTtlSeconds,
        }),
      inject: [API_CONFIG],
    },
    {
      /**
       * The API holds a provider instance for webhook signature verification.
       * Transaction fetching belongs to the worker, which builds its own
       * instance seeded with the demo account and transaction set.
       */
      provide: BANKING_PROVIDER,
      useFactory: (config: ApiConfig) =>
        createBankingProvider({
          name: config.bank.provider,
          simulator: {
            seed: config.bank.simulatorSeed,
            accounts: [],
            transactions: [],
            webhookSecret: config.bank.webhookSecret,
            duplicateRate: config.bank.simulatorDuplicateRate,
            lateRate: config.bank.simulatorLateRate,
            failureRate: config.bank.simulatorFailureRate,
          },
        }),
      inject: [API_CONFIG],
    },
    {
      provide: ASSISTANT_PROVIDER,
      useFactory: (config: ApiConfig) => {
        if (config.ai.provider === 'anthropic') {
          if (!config.ai.apiKey) {
            throw new DomainError(
              'ASSISTANT_UNAVAILABLE',
              'AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY. Use AI_PROVIDER=mock for the demo.',
            );
          }
          return new AnthropicAssistantProvider({
            apiKey: config.ai.apiKey,
            model: config.ai.model,
            maxOutputTokens: config.ai.maxOutputTokens,
            timeoutMs: config.ai.timeoutMs,
          });
        }
        return new MockAssistantProvider(config.ai.model);
      },
      inject: [API_CONFIG],
    },
  ],
  exports: [API_CONFIG, LOGGER, CLOCK, OBJECT_STORE, BANKING_PROVIDER, ASSISTANT_PROVIDER],
})
export class CoreModule {}
