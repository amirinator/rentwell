# 4. The worker reuses the API's feature modules

Status: accepted

## Context

The worker ingests payments, classifies exceptions and generates suggestions.
The API does the same things interactively. These are financial rules, and two
implementations of them would drift.

## Decision

`apps/api` exposes a `./modules` subpath export that exports the feature modules
and services without starting an HTTP server. `apps/worker` depends on
`@rentwell/api` and imports from that subpath, satisfying the API's injection
tokens from its own global module.

## Alternatives considered

**Duplicate the logic in the worker.** Rejected: two copies of exception
classification is precisely the drift this system exists to prevent.

**Extract a third package for shared services.** Reasonable, and the right move
if the shared surface grows. Today it would be a package containing most of the
API, which is not an improvement.

**Have the worker call the API over HTTP.** Rejected: ingestion must commit a
payment, its journal entry, its suggestions and any exception in one database
transaction. An HTTP boundary in the middle makes that impossible.

## Consequences

- `apps/api/src/main.ts` must never be imported by the worker — it starts a
  server on import. The subpath export exists to make that impossible by
  accident.
- The worker provides the API's tokens (`API_CONFIG`, `LOGGER`, `CLOCK`,
  `OBJECT_STORE`) from a `@Global()` module, because a provider declared in an
  importing module is not visible to the module it imports.
- The coupling is real and is worth watching. If the worker starts needing
  pieces of the API that the API does not need itself, that is the signal to
  extract the shared package.
