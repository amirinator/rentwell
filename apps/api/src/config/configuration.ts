/**
 * Environment configuration.
 *
 * Every setting is read once, at startup, through a schema that fails loudly.
 * A misconfigured service should refuse to start rather than discover the
 * problem on the first request that needs the missing value — particularly for
 * the session secret, where a silent default would be a security defect.
 */

import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Local development runs the API and the worker straight from source, where the
// settings live in a .env file that nothing else reads: neither pnpm nor
// ts-node-dev loads one, and the schema below requires SESSION_SECRET,
// DATABASE_URL and the S3 credentials, so both processes would refuse to start.
//
// This runs at module load, before `loadConfig` is called — `core.module.ts`
// calls it while being imported, so waiting until an entry point runs would be
// too late. `override: false` leaves any real environment variable untouched,
// which makes this a no-op in containers and in CI, where the environment is
// already populated and no .env file is present.
loadDotenv({ path: resolve(__dirname, '../../../../.env'), override: false });

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === 'boolean' ? value : /^(1|true|yes|on)$/i.test(value)));

const port = z.coerce.number().int().min(1).max(65_535);
/** A probability expressed as a fraction of 1. */
const rate = z.coerce.number().min(0).max(1);

const positiveInt = z.coerce.number().int().positive();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  API_PORT: port.default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  GRAPHQL_PATH: z.string().startsWith('/').default('/graphql'),
  GRAPHQL_MAX_COMPLEXITY: positiveInt.default(1200),
  GRAPHQL_MAX_DEPTH: positiveInt.default(12),
  GRAPHQL_INTROSPECTION: booleanish.default(true),

  SESSION_SECRET: z
    .string()
    .min(
      32,
      'SESSION_SECRET must be at least 32 characters. Generate one; do not reuse the example.',
    ),
  SESSION_TTL_HOURS: positiveInt.default(12),
  SESSION_COOKIE_NAME: z.string().default('rentwell.sid'),
  SESSION_COOKIE_SECURE: booleanish.default(false),
  SESSION_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  CSRF_COOKIE_NAME: z.string().default('rentwell.csrf'),
  PASSWORD_HASH_MEMORY_KIB: positiveInt.default(19_456),
  PASSWORD_HASH_ITERATIONS: positiveInt.default(2),
  PASSWORD_HASH_PARALLELISM: positiveInt.default(1),

  DATABASE_URL: z.string().min(1),

  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  QUEUE_PREFIX: z.string().default('rentwell'),
  IMPORT_MAX_ROWS: positiveInt.default(50_000),
  IMPORT_MAX_FILE_BYTES: positiveInt.default(26_214_400),

  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('rentwell-imports'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanish.default(true),
  S3_SIGNED_URL_TTL_SECONDS: positiveInt.default(300),

  BANK_PROVIDER: z.string().default('simulator'),
  BANK_SIMULATOR_SEED: z.string().default('rentwell-demo'),
  BANK_SIMULATOR_WEBHOOK_SECRET: z.string().min(8).default('rentwell-local-webhook-secret'),
  BANK_SYNC_PAGE_SIZE: positiveInt.default(100),
  // Simulator behaviour knobs. Documented in .env.example, so they are read
  // here rather than left to the adapter's internal defaults; the defaults
  // below are those same values, so an unset environment behaves identically.
  BANK_SIMULATOR_DUPLICATE_RATE: rate.default(0.08),
  BANK_SIMULATOR_LATE_RATE: rate.default(0.06),
  BANK_SIMULATOR_FAILURE_RATE: rate.default(0.05),

  AI_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
  AI_MODEL: z.string().default('claude-sonnet-5'),
  AI_PROMPT_VERSION: z.string().default('2026-09-01'),
  AI_MAX_TOOL_CALLS: positiveInt.default(8),
  AI_TIMEOUT_MS: positiveInt.default(30_000),
  AI_MAX_OUTPUT_TOKENS: positiveInt.default(2048),
  ANTHROPIC_API_KEY: z.string().optional(),

  OTEL_ENABLED: booleanish.default(false),
  OTEL_SERVICE_NAME: z.string().default('rentwell-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318'),

  BASE_CURRENCY: z.string().length(3).default('USD'),
});

export type RawConfig = z.infer<typeof schema>;

export interface ApiConfig {
  readonly env: RawConfig['NODE_ENV'];
  readonly isProduction: boolean;
  readonly logLevel: string;
  readonly http: {
    readonly port: number;
    readonly host: string;
    readonly webOrigin: string;
    readonly graphqlPath: string;
  };
  readonly graphql: {
    readonly maxComplexity: number;
    readonly maxDepth: number;
    readonly introspection: boolean;
  };
  readonly session: {
    readonly secret: string;
    readonly ttlHours: number;
    readonly cookieName: string;
    readonly secure: boolean;
    readonly sameSite: 'lax' | 'strict' | 'none';
    readonly csrfCookieName: string;
  };
  readonly password: {
    readonly memoryCost: number;
    readonly timeCost: number;
    readonly parallelism: number;
  };
  readonly databaseUrl: string;
  readonly redis: { readonly url: string; readonly queuePrefix: string };
  readonly imports: { readonly maxRows: number; readonly maxFileBytes: number };
  readonly storage: {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
    readonly signedUrlTtlSeconds: number;
  };
  readonly bank: {
    readonly provider: string;
    readonly simulatorSeed: string;
    readonly webhookSecret: string;
    readonly syncPageSize: number;
    readonly simulatorDuplicateRate: number;
    readonly simulatorLateRate: number;
    readonly simulatorFailureRate: number;
  };
  readonly ai: {
    readonly provider: 'mock' | 'anthropic';
    readonly model: string;
    readonly promptVersion: string;
    readonly maxToolCalls: number;
    readonly timeoutMs: number;
    readonly maxOutputTokens: number;
    readonly apiKey?: string;
  };
  readonly otel: {
    readonly enabled: boolean;
    readonly serviceName: string;
    readonly endpoint: string;
  };
  readonly baseCurrency: string;
}

export const API_CONFIG = Symbol('API_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const raw = parsed.data;

  if (raw.NODE_ENV === 'production') {
    // These are the two settings whose local defaults are unsafe in a
    // deployment. Failing at boot is the only reliable way to catch them.
    if (raw.SESSION_SECRET.includes('change-me')) {
      throw new Error('SESSION_SECRET still holds the example value. Set a real secret.');
    }
    if (!raw.SESSION_COOKIE_SECURE) {
      throw new Error('SESSION_COOKIE_SECURE must be true in production.');
    }
  }

  if (raw.AI_PROVIDER === 'anthropic' && !raw.ANTHROPIC_API_KEY) {
    throw new Error(
      'AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY. Use AI_PROVIDER=mock for the demo.',
    );
  }

  return {
    env: raw.NODE_ENV,
    isProduction: raw.NODE_ENV === 'production',
    logLevel: raw.LOG_LEVEL,
    http: {
      port: raw.API_PORT,
      host: raw.API_HOST,
      webOrigin: raw.WEB_ORIGIN,
      graphqlPath: raw.GRAPHQL_PATH,
    },
    graphql: {
      maxComplexity: raw.GRAPHQL_MAX_COMPLEXITY,
      maxDepth: raw.GRAPHQL_MAX_DEPTH,
      // Introspection is useful locally and a needless disclosure in production.
      introspection: raw.NODE_ENV === 'production' ? false : raw.GRAPHQL_INTROSPECTION,
    },
    session: {
      secret: raw.SESSION_SECRET,
      ttlHours: raw.SESSION_TTL_HOURS,
      cookieName: raw.SESSION_COOKIE_NAME,
      secure: raw.SESSION_COOKIE_SECURE,
      sameSite: raw.SESSION_COOKIE_SAMESITE,
      csrfCookieName: raw.CSRF_COOKIE_NAME,
    },
    password: {
      memoryCost: raw.PASSWORD_HASH_MEMORY_KIB,
      timeCost: raw.PASSWORD_HASH_ITERATIONS,
      parallelism: raw.PASSWORD_HASH_PARALLELISM,
    },
    databaseUrl: raw.DATABASE_URL,
    redis: { url: raw.REDIS_URL, queuePrefix: raw.QUEUE_PREFIX },
    imports: { maxRows: raw.IMPORT_MAX_ROWS, maxFileBytes: raw.IMPORT_MAX_FILE_BYTES },
    storage: {
      endpoint: raw.S3_ENDPOINT,
      region: raw.S3_REGION,
      bucket: raw.S3_BUCKET,
      accessKeyId: raw.S3_ACCESS_KEY_ID,
      secretAccessKey: raw.S3_SECRET_ACCESS_KEY,
      forcePathStyle: raw.S3_FORCE_PATH_STYLE,
      signedUrlTtlSeconds: raw.S3_SIGNED_URL_TTL_SECONDS,
    },
    bank: {
      provider: raw.BANK_PROVIDER,
      simulatorSeed: raw.BANK_SIMULATOR_SEED,
      webhookSecret: raw.BANK_SIMULATOR_WEBHOOK_SECRET,
      syncPageSize: raw.BANK_SYNC_PAGE_SIZE,
      simulatorDuplicateRate: raw.BANK_SIMULATOR_DUPLICATE_RATE,
      simulatorLateRate: raw.BANK_SIMULATOR_LATE_RATE,
      simulatorFailureRate: raw.BANK_SIMULATOR_FAILURE_RATE,
    },
    ai: {
      provider: raw.AI_PROVIDER,
      model: raw.AI_MODEL,
      promptVersion: raw.AI_PROMPT_VERSION,
      maxToolCalls: raw.AI_MAX_TOOL_CALLS,
      timeoutMs: raw.AI_TIMEOUT_MS,
      maxOutputTokens: raw.AI_MAX_OUTPUT_TOKENS,
      ...(raw.ANTHROPIC_API_KEY ? { apiKey: raw.ANTHROPIC_API_KEY } : {}),
    },
    otel: {
      enabled: raw.OTEL_ENABLED,
      serviceName: raw.OTEL_SERVICE_NAME,
      endpoint: raw.OTEL_EXPORTER_OTLP_ENDPOINT,
    },
    baseCurrency: raw.BASE_CURRENCY.toUpperCase(),
  };
}
