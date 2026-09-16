/**
 * Structured logging.
 *
 * Every log line is JSON with a correlation id, so one request can be followed
 * from the GraphQL resolver that started it, through the outbox event it wrote,
 * into the worker that consumed it.
 *
 * Redaction is configured at the logger rather than left to call sites: a
 * password, session cookie or provider secret must not reach the log even if
 * someone logs a whole request object by accident.
 */

import pino, { type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/** Paths pino replaces with `[redacted]` before writing a line. */
const REDACTED_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'csrfToken',
  '*.csrfToken',
  'sessionId',
  '*.sessionId',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'ANTHROPIC_API_KEY',
  'S3_SECRET_ACCESS_KEY',
  'DATABASE_URL',
];

export interface LoggerConfig {
  readonly serviceName: string;
  readonly level?: string;
  /** Human-readable output for local development. */
  readonly pretty?: boolean;
  readonly environment?: string;
}

export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    name: config.serviceName,
    level: config.level ?? 'info',
    base: { service: config.serviceName, env: config.environment ?? 'development' },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    // BigInt reaches logs through money fields; pino cannot serialise it.
    serializers: {
      err: pino.stdSerializers.err,
    },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map(replaceBigInt) as Parameters<typeof method>);
      },
    },
  };

  if (config.pretty) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(options);
}

function replaceBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(replaceBigInt);
  if (value && typeof value === 'object' && !(value instanceof Error)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = replaceBigInt(item);
    }
    return result;
  }
  return value;
}

/** A logger bound to one request, job or event. */
export function childLogger(
  logger: Logger,
  bindings: Record<string, string | number | undefined>,
): Logger {
  const clean: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (value !== undefined) clean[key] = value;
  }
  return logger.child(clean);
}
