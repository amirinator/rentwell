# Banking integration contract

Everything Rentwell learns from a bank arrives through one interface:
`BankingProvider`, in
[`packages/integrations/src/provider/types.ts`](../packages/integrations/src/provider/types.ts).

---

## The contract

```ts
interface BankingProvider {
  readonly name: string;
  listAccounts(): Promise<readonly ProviderAccount[]>;
  fetchTransactions(options: FetchOptions): Promise<TransactionPage>;
  parseWebhook(rawBody: string, signature: string | undefined): ProviderWebhookEvent;
}
```

Provider payloads never reach a charge, allocation or journal entry. An adapter
normalises them into the shapes in that file and keeps the original in `raw`,
which is stored on the transaction for support purposes and read by nothing that
computes money.

That separation is what makes the simulator a genuine stand-in rather than a
shortcut: swapping the adapter changes no domain code.

---

## Cursors, and why the ordering matters

`fetchTransactions` returns a page and a cursor. Rentwell persists the cursor
**only after the page it came from is durably processed**.

A crash between processing a page and saving its cursor replays that page, which
is harmless — ingestion deduplicates on the provider's own external id. The
opposite ordering would silently skip a page of payments, and a skipped payment
is not detectable from inside the system.

---

## Deduplication

Three layers, for three different problems.

**Record-level.** `(bankAccountId, providerKey, externalId)` is unique. The same
external id arriving twice with the same amount, date and currency is recorded
as a duplicate and creates nothing.

**Conflicting repeat.** The same external id arriving with _different_ financial
values is not a duplicate; it is a provider inconsistency. It raises a critical
`INTEGRATION_CONFLICT` exception naming both sets of values.

**File-level.** Import confirmation checks whether a completed import for the
same bank account already has this SHA-256. This supplements per-row
deduplication rather than replacing it: the same file uploaded twice is almost
always a mistake, while the same payment appearing in two different files is not.

---

## Webhooks

The HTTP endpoint verifies the HMAC signature **before parsing the body as
anything meaningful**, so an unsigned or forged delivery is rejected before it
reaches the domain. Comparison is constant-time, with a length check first
because `timingSafeEqual` throws on a length mismatch.

A verified delivery is stored, keyed `(connectionId, eventId)`, and a 202 is
returned immediately — a slow database must not cause the provider to retry a
delivery already held. The worker applies it asynchronously, claiming the event
in `ProcessedEvent` in the same transaction as the side effect, so a redelivery
finds the claim and does nothing.

---

## Reversals

A reversal carries `reversesExternalId`. Rentwell decides whether that target
actually exists, rather than trusting the provider's claim.

| Case                      | Outcome                                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target found              | Allocations are unwound first, then the receipt. Reversing the receipt while allocations were live would leave unapplied cash negative. A `REVERSED_PAYMENT` exception is always raised, because somebody has to decide what it means for the tenant's balance. |
| Target not found          | A critical `INTEGRATION_CONFLICT` exception. Silently ignoring it would hide a real integration problem.                                                                                                                                                        |
| Target in a closed period | Refused by the period lock and surfaced as a conflict. Forcing a posting into a closed period is a controller's decision, not a worker's.                                                                                                                       |

---

## Failure classification

`ProviderError` carries a `retryable` flag:

- **Retryable** — timeouts, rate limits, 5xx. Rethrown so BullMQ backs off. The
  cursor is unchanged, so the retry re-fetches the page that failed.
- **Not retryable** — a bad cursor, a failed signature, an unsupported event.
  Recorded on the connection and not retried, because retrying will not help.

---

## The simulator

The only provider shipped publicly. It exists to produce, on demand and without
credentials, the failure modes a real integration produces occasionally:

| Behaviour               | How it is produced                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Duplicate delivery      | The same record twice in one page                                                  |
| Late arrival            | A record held back and delivered on a later page, keeping its original posted date |
| Out-of-order events     | Held-back records are delivered before newer ones                                  |
| Transient failure       | The first fetch for a given cursor fails; the retry succeeds                       |
| Reversal                | A negative record naming an earlier `externalId`                                   |
| Unknown reversal target | A reversal naming an id that was never delivered                                   |

Everything is driven by a seeded PRNG (Mulberry32 — small, fast, and identical
across Node versions and platforms, unlike `Math.random`), so a given seed always
produces the same stream. That is what lets the demo guide, the integration
tests and the browser tests assert on exact outcomes.

A late arrival keeps its original posted date; only the delivery is late.
Rewriting the date would hide the very case being simulated.

`deterministicCleanStream: true` disables all injected chaos, for tests that
need an undisturbed stream.

---

## CSV imports

The expected header is exactly:

```
external_id,posted_date,amount,currency,reference,description
```

The parser is hand-written rather than pulled from a library, because the
failure modes that matter here are specific: a quoted field containing a newline
must not split a row, a stray byte-order mark must not corrupt the first column
name, and a truncated quote must be reported as one file-level error rather than
swallowing the rest of the file as a cascade of row errors.

Validation collects **every** problem in one pass, so an accountant fixes one
file rather than discovering errors one row at a time.

Deliberately rejected:

| Input                                    | Why                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `1.234` in USD                           | Sub-cent precision. Silently rounding would hide a bad file.                  |
| `1e5`                                    | Scientific notation is never a legitimate amount in a bank export.            |
| `03/15/2026`                             | `MM/DD` and `DD/MM` cannot be told apart safely. ISO ordering is required.    |
| `0.00`                                   | A zero-value payment cannot be reconciled.                                    |
| The same `external_id` twice in one file | Always a mistake; record-level dedupe would silently drop the second.         |
| A currency other than the account's      | Version 1 has no rate source, and inventing one would be worse than refusing. |

Accounting-style negatives (`(250.00)`), thousands separators and a leading
currency symbol are accepted, because real exports contain them.

---

## Processing, and what a crash costs

An import is processed in resumable batches. Each batch commits its payments,
its journal entries, its per-row records **and** the new `checkpointRow` in one
transaction.

A crash rolls back the batch in flight and leaves the checkpoint where the last
committed batch put it. On retry, processing resumes from there — and even if a
batch is replayed, the per-payment unique index turns every replayed row into a
recorded duplicate rather than a second payment.

The file is re-read from object storage on resume and its hash re-checked, so a
resumed run cannot process different bytes than the ones confirmed.

---

## Export safety

Every exported cell is escaped against spreadsheet formula execution: a leading
`=`, `+`, `-`, `@`, tab or carriage return is prefixed with a single quote.
Applied to values that originated inside Rentwell too, because a tenant name or
a payment memo can carry the payload.

A plain signed decimal is exempt, so `-1234.56` exports as a number a
spreadsheet can sum rather than as the text `'-1234.56`. `-1+1` is not a plain
decimal and is still neutralised.
