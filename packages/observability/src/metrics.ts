/**
 * Application metrics.
 *
 * The instruments below are the ones named in the specification's observability
 * section. They are declared once, here, so a metric cannot be created twice
 * with different units or names in two services.
 *
 * When OpenTelemetry is disabled (the default for local development) every
 * instrument becomes a no-op through the API's default meter provider, so
 * instrumentation call sites need no conditional logic.
 */

import {
  metrics,
  type Attributes,
  type Counter,
  type Histogram,
  type UpDownCounter,
} from '@opentelemetry/api';

const METER_NAME = 'rentwell';

let cached: RentwellMetrics | null = null;

export interface RentwellMetrics {
  /** GraphQL operation latency, milliseconds. */
  readonly apiLatency: Histogram;
  readonly apiErrors: Counter;
  /** Depth of each BullMQ queue, sampled by the worker. */
  readonly queueDepth: UpDownCounter;
  /** Age of the oldest waiting job, seconds. */
  readonly queueOldestJobAge: Histogram;
  /** Rows processed per import. */
  readonly importRows: Counter;
  readonly importDuration: Histogram;
  readonly workerRetries: Counter;
  /** Allocation approvals rejected because balances or versions moved. */
  readonly allocationConflicts: Counter;
  /** Age of the oldest undispatched outbox event, seconds. */
  readonly outboxLag: Histogram;
  readonly outboxDispatched: Counter;
  readonly closeFailures: Counter;
  readonly assistantLatency: Histogram;
  readonly assistantFailures: Counter;
  readonly assistantToolCalls: Counter;
  /** Postings rejected because the period had closed. */
  readonly closedPeriodRejections: Counter;
}

export function getMetrics(): RentwellMetrics {
  if (cached) return cached;
  const meter = metrics.getMeter(METER_NAME);

  cached = {
    apiLatency: meter.createHistogram('rentwell.api.latency', {
      description: 'GraphQL operation latency',
      unit: 'ms',
    }),
    apiErrors: meter.createCounter('rentwell.api.errors', {
      description: 'GraphQL operations that returned a domain or internal error',
    }),
    queueDepth: meter.createUpDownCounter('rentwell.queue.depth', {
      description: 'Jobs waiting in a queue',
    }),
    queueOldestJobAge: meter.createHistogram('rentwell.queue.oldest_job_age', {
      description: 'Age of the oldest waiting job',
      unit: 's',
    }),
    importRows: meter.createCounter('rentwell.import.rows', {
      description: 'Import rows processed, labelled by outcome',
    }),
    importDuration: meter.createHistogram('rentwell.import.duration', {
      description: 'Time from confirmation to terminal import status',
      unit: 'ms',
    }),
    workerRetries: meter.createCounter('rentwell.worker.retries', {
      description: 'Job attempts beyond the first',
    }),
    allocationConflicts: meter.createCounter('rentwell.allocation.conflicts', {
      description: 'Allocation approvals rejected by a balance, version or period check',
    }),
    outboxLag: meter.createHistogram('rentwell.outbox.lag', {
      description: 'Age of the oldest undispatched outbox event',
      unit: 's',
    }),
    outboxDispatched: meter.createCounter('rentwell.outbox.dispatched', {
      description: 'Outbox events handed to the queue',
    }),
    closeFailures: meter.createCounter('rentwell.close.failures', {
      description: 'Period close attempts rejected by the checklist',
    }),
    assistantLatency: meter.createHistogram('rentwell.assistant.latency', {
      description: 'Assistant run wall-clock time',
      unit: 'ms',
    }),
    assistantFailures: meter.createCounter('rentwell.assistant.failures', {
      description: 'Assistant runs that failed or exceeded their budget',
    }),
    assistantToolCalls: meter.createCounter('rentwell.assistant.tool_calls', {
      description: 'Assistant tool invocations, labelled by tool and allow/deny',
    }),
    closedPeriodRejections: meter.createCounter('rentwell.period.closed_rejections', {
      description: 'Financial writes rejected because the period was closed',
    }),
  };

  return cached;
}

/** Times an operation and records it on a histogram, success or failure. */
export async function timed<T>(
  histogram: Histogram,
  attributes: Attributes,
  work: () => Promise<T>,
): Promise<T> {
  const start = process.hrtime.bigint();
  try {
    const result = await work();
    histogram.record(elapsedMs(start), { ...attributes, outcome: 'success' });
    return result;
  } catch (error) {
    histogram.record(elapsedMs(start), { ...attributes, outcome: 'error' });
    throw error;
  }
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

/** Test seam: forgets the cached instruments so a new meter provider is used. */
export function resetMetricsForTesting(): void {
  cached = null;
}
