# 3. Idempotency by construction, not by a generic processed-event table

Status: accepted

## Context

Outbox delivery is at-least-once, so every consumer must tolerate redelivery.

The standard pattern is a `ProcessedEvent` table: claim the event id, skip if it
is already claimed.

## Decision

Use `ProcessedEvent` **only** for consumers whose work is a single transaction.
For multi-transaction consumers, make the work idempotent by construction and do
not claim.

| Consumer              | What makes a replay safe                                                         |
| --------------------- | -------------------------------------------------------------------------------- |
| Import processing     | `checkpointRow` + unique index on `(bankAccountId, providerKey, externalId)`     |
| Provider sync         | Cursor advanced only behind durable work, plus the same unique index             |
| Suggestion generation | Pure function of current records, stored by upsert on the suggestion fingerprint |
| Webhook processing    | `ProcessedEvent`, claimed in the same transaction as the side effect             |

## Rationale

A claim taken at the start of a multi-transaction job survives a mid-job crash.
The BullMQ retry then finds the event claimed and skips — abandoning an import
half-done, or a provider sync half-complete.

The generic pattern actively breaks retries for exactly the jobs that most need
them. Applying it uniformly would have looked more consistent and been wrong.

Underneath all of it, `(organizationId, postingEventId)` is unique on
`JournalEntry`, so no financial effect can be doubled even if every other guard
were removed.

## Consequences

- Each consumer documents why a replay is safe. The note at the foot of
  `import.processor.ts` exists for that reason, not as decoration.
- A new consumer has to make this decision explicitly rather than copying the
  pattern from its neighbour.
