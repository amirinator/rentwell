# 2. Transaction-scoped advisory locks for accounting periods

Status: accepted

## Context

A controller closes 2026-03 at the same moment a worker posts a receipt into it.
Both transactions are valid in isolation. Only two outcomes are acceptable:
either the posting lands and the close sees it, or the close lands and the
posting is refused.

Row locks do not help, because the posting and the close touch different rows.
There is no shared row to contend on.

## Decision

Both sides take a PostgreSQL transaction-scoped advisory lock keyed on a 64-bit
hash of `(propertyId, period)`, and follow one rule without exception:

> Acquire the period lock, then read the period's state, then act.

A transaction touching several periods takes their locks in sorted order.

## Alternatives considered

**`SERIALIZABLE` isolation.** Would detect the anomaly, but as a retry storm
under contention — and the contended resource is known ahead of time. Explicit
locking is cheaper and far more predictable.

**A lock row per period, taken `FOR UPDATE`.** Works, but the row has to exist
before the first posting, which is an upsert race of its own, and it leaves lock
rows to garbage-collect.

**Checking `status != 'CLOSED'` before posting.** The obvious approach, and
wrong: the check and the write are not atomic with respect to the close.

## Consequences

- Advisory locks release at commit or rollback, so a crashed worker cannot
  strand a property.
- A hash collision between two `(property, period)` pairs makes them share a
  lock. That costs a little concurrency and never costs correctness, which is an
  acceptable trade for not needing a lock registry table.
- Sorted lock ordering is mandatory. Two transactions taking two locks in
  opposite orders is the textbook deadlock, and
  `lockPeriodsInOrder` exists so no call site has to remember.
