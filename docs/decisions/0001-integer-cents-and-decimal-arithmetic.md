# 1. Integer minor units, with decimal arithmetic for intermediates

Status: accepted

## Context

Monetary values need a representation that cannot lose precision, and
calculations — proration, splits, remainders — need intermediate values that are
not yet whole cents.

## Decision

Store money as `BIGINT` minor units plus an explicit currency. Perform every
intermediate calculation in a BigInt-backed fixed-point `Decimal`, and round
exactly once, where a value becomes a persisted charge line or allocation
amount.

## Alternatives considered

**IEEE-754 doubles.** Rejected outright. `0.1 + 0.2 !== 0.3`, and the errors
accumulate across a portfolio in ways that surface as a month-end discrepancy
nobody can trace back to its cause.

**`NUMERIC` / `DECIMAL` columns.** Precise, but a decimal column can acquire a
fractional part through a careless operation and nothing complains. An integer
cannot: if a value is not a whole number of cents, the conversion throws.

**32-bit `INTEGER`.** Tops out at 21,474,836.47 in a two-decimal currency. A
portfolio-level aggregate exceeds that.

**A bare `number` without its currency.** Rejected because it lets a EUR payment
settle a USD invoice silently. The currency is never implicit.

## Consequences

- Values crossing the JavaScript boundary are checked against
  `Number.MAX_SAFE_INTEGER` and throw rather than truncating.
- Lint blocks `Math.round` and `Number.parseFloat` outside tests, because those
  two calls are how float arithmetic gets reintroduced by accident.
- Every prorated charge stores its inputs and its unrounded result, so the
  figure can be reproduced from the record rather than taken on trust.
