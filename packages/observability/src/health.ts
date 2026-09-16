/**
 * Health and readiness.
 *
 * The two endpoints answer different questions and must not be conflated:
 *
 *  - **Liveness** (`/healthz`): is this process still working? It checks
 *    nothing external, so a database blip does not cause an orchestrator to
 *    restart a perfectly healthy process and make the outage worse.
 *  - **Readiness** (`/readyz`): can this process serve traffic right now? It
 *    checks every dependency it needs, so a process with no database is taken
 *    out of the load balancer instead of returning errors.
 */

export type HealthState = 'ok' | 'degraded' | 'failing';

export interface CheckResult {
  readonly name: string;
  readonly state: HealthState;
  readonly durationMs: number;
  readonly detail?: string;
}

export interface HealthReport {
  readonly state: HealthState;
  readonly checks: readonly CheckResult[];
  readonly uptimeSeconds: number;
  readonly version: string;
  readonly checkedAt: string;
}

export interface HealthCheck {
  readonly name: string;
  /** Resolves when healthy; rejects or returns a detail string when not. */
  run(): Promise<string | void>;
  /** A failure here degrades rather than fails the overall report. */
  readonly optional?: boolean;
  readonly timeoutMs?: number;
}

const startedAt = Date.now();

async function runCheck(check: HealthCheck): Promise<CheckResult> {
  const began = Date.now();
  const timeoutMs = check.timeoutMs ?? 2_000;

  try {
    const detail = await withTimeout(check.run(), timeoutMs, check.name);
    return {
      name: check.name,
      state: 'ok',
      durationMs: Date.now() - began,
      ...(typeof detail === 'string' ? { detail } : {}),
    };
  } catch (error) {
    return {
      name: check.name,
      state: check.optional ? 'degraded' : 'failing',
      durationMs: Date.now() - began,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} check timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function runHealthChecks(
  checks: readonly HealthCheck[],
  version = '1.0.0',
): Promise<HealthReport> {
  const results = await Promise.all(checks.map(runCheck));

  const state: HealthState = results.some((result) => result.state === 'failing')
    ? 'failing'
    : results.some((result) => result.state === 'degraded')
      ? 'degraded'
      : 'ok';

  return {
    state,
    checks: results,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    version,
    checkedAt: new Date().toISOString(),
  };
}

/** HTTP status for a report. Degraded still serves traffic. */
export function healthStatusCode(report: HealthReport): number {
  return report.state === 'failing' ? 503 : 200;
}
