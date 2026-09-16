/**
 * Filters that live in the URL.
 *
 * The specification asks for persistent filters and shareable page URLs, and
 * those are the same requirement: if the filter state is in the query string,
 * a reload keeps it and a pasted link reproduces exactly what the sender was
 * looking at. Anything held only in component state fails both.
 *
 * Drill-down depends on this too. A dashboard figure links to the records
 * behind it by carrying the same period and property filter into the next
 * screen, so the number and the list cannot disagree about what they cover.
 */

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export type FilterValue = string | string[] | boolean | null | undefined;

/**
 * Widens the literal types TypeScript infers from a defaults object.
 *
 * `useFilters({ onlyBlocking: false })` infers the property as the literal
 * `false`, which then rejects `setFilters({ onlyBlocking: true })` from a
 * checkbox. Widening each value to its base type is what makes the defaults
 * object usable as a shape rather than as a set of constants.
 */
export type WidenFilters<T> = {
  [K in keyof T]: T[K] extends boolean
    ? boolean
    : T[K] extends readonly string[]
      ? string[]
      : T[K] extends string
        ? string
        : T[K];
};

export function useFilters<T extends Record<string, FilterValue>>(defaults: T) {
  const [searchParams, setSearchParams] = useSearchParams();

  const values = useMemo(() => {
    const result = { ...defaults } as Record<string, FilterValue>;

    for (const key of Object.keys(defaults)) {
      const raw = searchParams.getAll(key);
      if (raw.length === 0) continue;

      const fallback = defaults[key];
      if (Array.isArray(fallback)) result[key] = raw;
      else if (typeof fallback === 'boolean') result[key] = raw[0] === 'true';
      else result[key] = raw[0] ?? null;
    }

    return result as WidenFilters<T>;
  }, [searchParams, defaults]);

  const setFilters = useCallback(
    (updates: Partial<WidenFilters<T>>) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);

          for (const [key, value] of Object.entries(updates)) {
            next.delete(key);

            if (value === null || value === undefined || value === '') continue;
            if (Array.isArray(value)) {
              for (const item of value) next.append(key, item);
            } else {
              next.set(key, String(value));
            }
          }

          // A filter change resets pagination: keeping a cursor from the old
          // result set would page through rows the new filter never selected.
          next.delete('after');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const cursor = searchParams.get('after');

  const setCursor = useCallback(
    (value: string | null) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value) next.set('after', value);
          else next.delete('after');
          return next;
        },
        // Paging is navigation, so it belongs in history: the back button
        // should return to the previous page of results.
        { replace: false },
      );
    },
    [setSearchParams],
  );

  return { filters: values, setFilters, cursor, setCursor };
}

/** The current accounting period, as YYYY-MM. */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The period the demonstration data covers.
 *
 * The seeded data is dated 2026, so defaulting to the real current month would
 * show an empty dashboard on a fresh checkout. `VITE_DEFAULT_PERIOD` overrides
 * it; otherwise the current month is used once the data catches up.
 */
export function defaultPeriod(): string {
  const configured = import.meta.env.VITE_DEFAULT_PERIOD as string | undefined;
  if (configured && /^\d{4}-\d{2}$/.test(configured)) return configured;
  return currentPeriod();
}

/** Builds a link that carries the current period and property scope forward. */
export function withFilters(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}
