/**
 * SDL loading.
 *
 * The schema lives in `schema/schema.graphql` as the single source of truth:
 * the API serves it, the client's codegen reads it, and a reviewer can read it
 * without running anything. This module finds it whether the process is running
 * from `src` (ts-node, vitest) or from `dist` (built image).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CANDIDATE_PATHS = [
  // Running from dist/, with the SDL copied alongside by the build.
  join(__dirname, 'schema', 'schema.graphql'),
  // Running from dist/ before the copy step, or from src/ in development.
  join(__dirname, '..', 'schema', 'schema.graphql'),
  join(__dirname, '..', '..', 'schema', 'schema.graphql'),
];

let cached: string | null = null;

export function loadTypeDefs(): string {
  if (cached !== null) return cached;

  for (const candidate of CANDIDATE_PATHS) {
    if (existsSync(candidate)) {
      cached = readFileSync(candidate, 'utf8');
      return cached;
    }
  }

  throw new Error(
    `Could not find schema.graphql. Looked in:\n${CANDIDATE_PATHS.map((p) => `  ${p}`).join('\n')}`,
  );
}

/** Absolute path to the SDL, for codegen and for the schema-diff CI check. */
export function typeDefsPath(): string {
  for (const candidate of CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('schema.graphql not found');
}
