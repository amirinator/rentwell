/**
 * Injectable clock.
 *
 * Financial code decides posting dates and period membership from "now". A test
 * that cannot control now can only assert vaguely, so time is a dependency
 * rather than a global call to `new Date()`.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock fixed at an instant, for tests and deterministic seeding. */
export function fixedClock(instant: Date | string): Clock {
  const fixed = instant instanceof Date ? instant : new Date(instant);
  return { now: () => new Date(fixed.getTime()) };
}
