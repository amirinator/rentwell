# Architecture

---

## Shape

```
                 React + Apollo Client
                          │
                       GraphQL
                          │
           NestJS + Apollo Server (apps/api)
                          │
   ┌──────────────────────┼──────────────────────┐
   │                      │                      │
 identity            receivables            reconciliation
 portfolio           subledger              period close
                     assistant
                          │
                     PostgreSQL          ← the source of truth
                          │
                 transactional outbox
                          │
                     dispatcher          ← apps/worker
                          │
                    Redis / BullMQ       ← queue state only
                          │
         ┌────────────────┼────────────────┐
   import processing  provider sync   suggestion generation

   Private object storage (MinIO / S3): import files
   OpenTelemetry: traces and metrics, opt-in
```

---

## The decisions worth defending

### One database boundary for financial transactions

Charge generation, allocation approval and period close each write several
tables — the business record, its journal entry, its audit event, its outbox
event — and all of them must commit together. Splitting those tables across
services would turn every financial operation into a distributed transaction,
and distributed transactions over money are where reconciliation systems go
wrong.

So the API is modular but not distributed. Modules are separate for readability
and ownership; they share one PostgreSQL database and one transaction scope.

### PostgreSQL is the source of truth; Redis is not

Every financial fact lives in PostgreSQL. Redis holds queue state and nothing
else. Losing Redis costs throughput: the outbox still holds every event, and the
dispatcher republishes them. Losing PostgreSQL loses the system, which is why
that is the thing with the constraints, the locks and the backups.

### The transactional outbox

A business change and the event announcing it are written in one transaction.
There is no window in which a committed allocation has no event, and none in
which an event describes a change that never happened.

The dispatcher polls `outbox_events` and publishes to the queue, then marks the
row dispatched. It can crash between those two steps, so delivery is
**at-least-once** — deliberately. Marking first would lose an event on the same
crash, and a lost event is far worse than a repeated one when every consumer is
idempotent.

Rows are claimed with `FOR UPDATE SKIP LOCKED`, so several dispatchers can run
without handing one row to two of them and without one slow row blocking the
rest.

### Where idempotency actually comes from

This is the part most worth reading carefully, because the obvious answer is
wrong.

The obvious answer is: every consumer claims the event id in `ProcessedEvent`
and skips if it is already claimed. That works only when the consumer's work is
one transaction.

An import spans many transactions. A claim taken up front survives a mid-file
crash, and the BullMQ retry would then find the event claimed and skip,
abandoning the import half-done. A provider sync has the same shape.

So those consumers are idempotent **by construction** instead, which is
stronger:

| Consumer              | What makes a replay safe                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import processing     | `checkpointRow` advances only with the batch that committed; the unique index on `(bankAccountId, providerKey, externalId)` turns a replayed row into a recorded duplicate |
| Provider sync         | The cursor advances only behind durably processed pages; ingestion deduplicates on the provider's own external id                                                          |
| Suggestion generation | The engine is a pure function of current records; storage upserts on the suggestion fingerprint                                                                            |
| Webhook processing    | Single transaction with no natural key, so it **does** claim `ProcessedEvent` — the claim and the side effect commit together                                              |

Underneath all of it, `(organizationId, postingEventId)` is unique on
`JournalEntry`, so no financial effect can be doubled even if every other guard
were removed.

### The close-versus-posting race

The sharpest concurrency problem in the system: a controller closes 2026-03 at
the same moment a worker posts a receipt into it.

Row locks do not solve it, because the posting and the close touch different
rows. The answer is a transaction-scoped PostgreSQL advisory lock keyed on
`(propertyId, period)`, and one rule applied without exception:

> **Acquire the period lock, then read the period's state, then act.**

Whichever transaction takes the lock first runs to completion. The other blocks,
and by the time it reads the period state it sees the committed outcome. A
posting arriving after the close therefore sees `CLOSED` and is rejected.

Advisory locks release at commit or rollback, so a crashed worker cannot strand
a property. A transaction touching several periods takes their locks in sorted
order, because two transactions taking two locks in opposite orders is the
textbook deadlock.

`apps/api/test/integration/concurrency.test.ts` runs the race both ways and
asserts the only two acceptable outcomes.

### Optimistic concurrency on financial records

Charges, transactions and periods carry a `version`. A mutation sends the
version the reviewer saw; the update is `WHERE version = expected`. Two
concurrent approvals cannot both succeed — the loser matches zero rows and
raises `STALE_RECORD`, which the UI renders as "someone else changed this" and
keeps on screen until dismissed.

This is preferred to `SELECT FOR UPDATE` here because the contended rows are
already known and the failure mode is something a person must see, not something
to serialise silently.

### The worker reuses the API's modules

`apps/worker` depends on `@rentwell/api/modules`, a subpath export that exposes
the feature modules without starting an HTTP server. The alternative — a second
copy of exception classification and suggestion generation in the worker — would
be two implementations of the same financial rules, which is exactly the kind of
drift this system exists to prevent.

### The domain package depends on nothing

`packages/domain` imports no framework, no database client, no I/O. Proration,
allocation limits, matching, journal construction, close readiness and the
permission matrix are all pure functions over plain values.

That is what lets `pnpm --filter @rentwell/domain test` prove the rules that
decide money in about two seconds, with no services running. It is also why the
Prisma enums are duplicated there rather than imported — and why
`packages/database/test/enum-parity.test.ts` fails the build if the two ever
drift.

---

## Request lifecycle

1. The GraphQL context factory resolves the session from the cookie and builds
   the `AccessContext`. **This is the only place authentication happens**, so no
   resolver can skip it.
2. Mutations are checked for CSRF here too, before any resolver runs.
3. Per-request DataLoaders are constructed, scoped to the viewer's organization,
   so a loader can never return a row from another one even if a resolver forgets
   to check.
4. The resolver calls `authorize(ctx, action)` and, where a record is involved,
   `authorizeProperty(ctx, action, record)` — against the record read from the
   database, not an id from the request.
5. A financial write opens a transaction, takes the period lock, re-reads, runs
   the domain rules against what it read, and commits the business change,
   journal entries, audit events and outbox events together.

---

## Error handling

Domain errors carry a stable `code` from a closed vocabulary. The API maps it to
`extensions.code` and an HTTP status; clients branch on the code, which does not
change when a message is reworded.

An unexpected error never leaks its message or stack. It is logged in full with
the correlation id and returned as `INTERNAL_ERROR` with that id, which is what
turns "it broke" into a support request someone can act on.

---

## Observability

Structured JSON logs with a correlation id that follows a request into the
outbox event it wrote and into the worker that consumed it. Redaction is
configured at the logger, not left to call sites.

OpenTelemetry is off by default: local development needs no collector, and a
demonstration should not fail because an OTLP endpoint is unreachable. When
enabled it registers both a trace exporter and a metric reader, which is what
makes the instruments in `packages/observability/src/metrics.ts` export rather
than stay no-ops.

`/healthz` checks nothing external on purpose — a database blip must not cause
an orchestrator to restart a working process and deepen the outage. `/readyz`
checks every dependency, so a process that cannot reach the database is removed
from the load balancer instead of returning errors.
