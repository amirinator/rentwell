/**
 * OpenTelemetry bootstrap and correlation.
 *
 * Tracing is off by default. Local development needs no collector, and a
 * demonstration should not fail because an OTLP endpoint is unreachable. Set
 * `OTEL_ENABLED=true` to turn it on.
 *
 * Correlation ids are independent of tracing: they are always present, always
 * logged, and always returned to the client in a response header, so a support
 * conversation can start from an id the user can see.
 */

import { randomUUID } from 'node:crypto';
import { SpanStatusCode, context, trace, type Span, type Tracer } from '@opentelemetry/api';

export interface TracingConfig {
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly otlpEndpoint?: string;
  readonly environment?: string;
}

export interface TracingHandle {
  readonly enabled: boolean;
  shutdown(): Promise<void>;
}

/**
 * Starts the Node SDK when enabled. The SDK packages are imported lazily so a
 * deployment that never turns tracing on does not pay their startup cost, and
 * so a missing optional dependency degrades to "tracing off" rather than a
 * crash at boot.
 */
export async function startTracing(config: TracingConfig): Promise<TracingHandle> {
  if (!config.enabled) {
    return { enabled: false, shutdown: async () => undefined };
  }

  try {
    const [
      { NodeSDK },
      { OTLPTraceExporter },
      { OTLPMetricExporter },
      { PeriodicExportingMetricReader },
      { Resource },
      semconv,
    ] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/exporter-metrics-otlp-http'),
      import('@opentelemetry/sdk-metrics'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
    ]);

    const endpoint = config.otlpEndpoint ?? 'http://localhost:4318';

    const sdk = new NodeSDK({
      resource: new Resource({
        [semconv.SEMRESATTRS_SERVICE_NAME]: config.serviceName,
        [semconv.SEMRESATTRS_SERVICE_VERSION]: config.serviceVersion ?? '1.0.0',
        [semconv.SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: config.environment ?? 'development',
      }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      // Registering the reader here is what makes the instruments in
      // metrics.ts export rather than stay no-ops.
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: 15_000,
      }),
    });

    sdk.start();
    return { enabled: true, shutdown: () => sdk.shutdown() };
  } catch (error) {
    // Tracing is diagnostic. Losing it must never take the service with it.
    // eslint-disable-next-line no-console
    console.warn('OpenTelemetry failed to start; continuing without tracing.', error);
    return { enabled: false, shutdown: async () => undefined };
  }
}

export function getTracer(name = 'rentwell'): Tracer {
  return trace.getTracer(name);
}

/** Runs `work` inside a span, recording exceptions and setting the status. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await work(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

// --------------------------------------------------------------------------
// Correlation
// --------------------------------------------------------------------------

export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Accepts a caller-supplied correlation id when it looks safe, otherwise mints
 * one. Caller-supplied values reach logs, so they are length-limited and
 * restricted to characters that cannot forge a log field.
 */
export function resolveCorrelationId(supplied: string | string[] | undefined): string {
  const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
  if (typeof candidate === 'string' && /^[A-Za-z0-9_.:-]{8,64}$/.test(candidate)) {
    return candidate;
  }
  return randomUUID();
}

/** The active trace id, for correlating a log line with a collected trace. */
export function activeTraceId(): string | undefined {
  const span = trace.getSpan(context.active());
  const spanContext = span?.spanContext();
  return spanContext && spanContext.traceId !== '0'.repeat(32) ? spanContext.traceId : undefined;
}
