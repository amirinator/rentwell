# Performance

## Status: not measured

**No benchmark has been run, so this document reports no numbers.**

The specification sets targets. Targets are not results, and publishing a table
of the targets under a heading like "performance" would imply measurement that
has not happened. This page describes how to take the measurements and what a
report has to state to be worth reading.

---

## The targets

| Operation                   | Target                                |
| --------------------------- | ------------------------------------- |
| Standard paginated queries  | p95 below 500 ms                      |
| Portfolio summary           | p95 below 1 second                    |
| 10,000-row import           | Complete within 2 minutes             |
| Standard financial mutation | p95 below 750 ms                      |
| Background processing       | Does not block interactive navigation |

---

## What a result must state

A latency figure without its context is not a result. Any table added below must
be accompanied by:

- **Hardware** — CPU model and core count, memory, storage type. A p95 on an
  NVMe laptop says nothing about a networked volume.
- **Topology** — whether the application, database and Redis were on one host.
  Co-located Postgres removes a network hop that dominates short queries.
- **Dataset** — property, lease, charge and transaction counts, and the
  distribution. p95 over 200 charges is not p95 over 200,000.
- **Concurrency** — virtual users and think time. A single-threaded run measures
  service time, not a percentile under load.
- **Whether timings include network latency**, and where the client ran.
- **Warm-up** — how many requests were discarded before recording. The first
  query against a cold pool is not representative, and neither is a query
  against a fully warm page cache if the production workload will not be.
- **Prisma connection pool size**, and whether it saturated.

---

## Method

### 1. A separate load dataset

Do **not** benchmark the demonstration seed. It is sized for readability.

```bash
SEED_PROPERTY_COUNT=200 SEED_LEASE_COUNT=20000 pnpm seed:reset
```

The load dataset should be an order of magnitude beyond the expected working
set, and it must be regenerated between runs so caching does not accumulate
across measurements.

### 2. Warm, then measure

Run the target operation until the connection pool is established and the query
planner has statistics, discard those samples, then record.

### 3. Report percentiles, not averages

An average hides the tail, and the tail is what a user experiences as "the
system is slow". Report p50, p95 and p99, and the sample count.

### 4. Measure the import end to end

The import target is wall-clock from confirmation to terminal status, including
the queue hop and every batch commit — not the time spent inside the parser.

```sql
SELECT "id",
       EXTRACT(EPOCH FROM ("completedAt" - "confirmedAt")) AS seconds,
       "totalRows",
       "totalRows" / NULLIF(EXTRACT(EPOCH FROM ("completedAt" - "confirmedAt")), 0) AS rows_per_second
FROM "import_batches"
WHERE "status" = 'COMPLETED'
ORDER BY "completedAt" DESC
LIMIT 20;
```

### 5. Check the queries, not just the clock

`createPrismaClient` logs any statement over 500 ms. With
`OTEL_ENABLED=true` the API also exports operation latency per GraphQL
operation name, which is the figure the targets are about.

---

## Where the cost is expected to be, and what was done about it

These are design decisions, not measurements. They are listed so that a
benchmark has hypotheses to confirm or refute.

**Property card aggregates.** Five fields on `Property` are aggregates. Resolved
naively, a list of 25 properties would run 125 aggregate queries. They are
served by one batched DataLoader that runs five grouped queries for the whole
page.

**Receivables aging.** Bucketing in application code would mean transferring
every open charge in the portfolio on every dashboard load. A maintained
`openCents` column, kept in step by every write path, makes "still outstanding"
an indexable predicate, and the bucketing happens in SQL.

**Cursor pagination.** Cursors encode the sort key and the row id, not an
offset. `OFFSET 10000` makes Postgres walk ten thousand rows; a compound
comparison on an indexed pair does not. It also stops a concurrent import from
making a list skip or repeat rows.

**Combined-payment search.** Exhaustive subset search is exponential, so it is
bounded to ten charges and five per combination, with pruning on the best
solution found so far.

**Import batching.** Rows are processed in configurable batches
(`IMPORT_BATCH_SIZE`, default 250) rather than one transaction for the file or
one per row. One transaction for 10,000 rows would hold locks for minutes; one
per row would pay the commit cost 10,000 times.

**Indexes.** `packages/database/prisma/schema.prisma` carries indexes for the
filters the UI actually issues: `(propertyId, period, status)` on charges,
`(propertyId, openCents, dueDate)` for aging, `(propertyId, status, postedDate)`
on transactions, `(status, availableAt)` on the outbox.

---

## Recording a result

When a benchmark is run, replace this section with a table and keep the method
section above it. A result that cannot be reproduced from the description is not
a result.
