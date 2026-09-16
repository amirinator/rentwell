# Public version: scope, provenance and limitations

---

## Provenance

All code in this repository was written for this project.

All data is synthetic. Tenants, properties, addresses, payments and people are
generated from a seed string by
[`packages/test-fixtures`](../packages/test-fixtures) and correspond to nothing
real. Email addresses use `.example` and `.invalid`, which RFC 2606 reserves and
which cannot be registered.

No production data of any kind is committed here, and no credential is. The demo
password is printed by the seed and stated in the README, because it protects
nothing.

---

## What works end to end

These are implemented and reachable through the interface, not only through a
test:

- Organization and property access control, including property-scoped roles
- Properties, units, tenants, leases, effective-dated charge schedules
- Charge generation with proration, preview-and-confirm, and idempotency
- Credit adjustments against posted charges
- CSV import: upload, validation, hash-bound confirmation, resumable processing
- Simulated banking provider: cursor sync, webhooks, duplicates, late arrivals,
  transient failures, out-of-order events, reversals
- Reconciliation: exact, partial, combined, over-payment, unapplied cash
- Explainable, deterministic match suggestions with stored evidence
- Allocation approval and reversal under period locks and version checks
- Exception lifecycle with resolution rules that check what actually happened
- Double-entry receivables subledger with a self-proving balance check
- Month-end close with a checklist, acknowledgements and immutable snapshots
- Read-only AI investigation assistant with grounded citations
- Audit history and operational monitoring
- Deterministic demonstration data and a reset command

---

## What is deliberately out of scope

### Currency

USD only, one accounting policy. Currency is stored explicitly on every monetary
record and cross-currency operations are **rejected** rather than converted,
because version 1 has no rate source and inventing one would be worse than
refusing. Multi-currency is not implemented.

### Not a general ledger

This is a receivables subledger with five accounts and one posting policy. There
is no tax calculation, no bank reconciliation against a statement balance, no
trial balance, no financial statements, no multi-entity consolidation.

Rentwell does not execute payments, originate mortgages, calculate taxes, or
provide a corporate general ledger.

### Banking

The simulator is a real adapter behind the real interface, and it produces the
failure modes a real integration produces. It is not a bank. Live banking
connections are outside the public demonstration.

### Approvals

An accountant approves allocations directly. There is no maker/checker second
approver. The domain keeps the `PENDING_APPROVALS` close blocker for the flow a
later version would add; today it is always satisfied.

Similarly, `activePostingJobCount` in the close checklist is always zero: every
posting happens inside a request or inside an outbox consumer, so undispatched
outbox events are the complete in-flight signal.

### Partial reversal

An allocation is reversed all-or-nothing. A smaller correction is a full
reversal followed by a new, smaller allocation, so no two records claim the same
cents.

### Administration

The administration screen is read-only. It shows who holds which role and which
properties each person is scoped to, which is the question it exists to answer.
Changing memberships, assignments or integration settings is not implemented in
version 1.

### Performance

**No benchmark has been run.** The targets in the specification are targets.
[`performance-results.md`](performance-results.md) describes the method and what
a result must state; it reports no numbers, because none have been taken.

---

## Claims stated precisely

Where a claim could be read as stronger than it is, this is what is actually
true.

**"Audit history is append-only."** No resolver, service or job in this codebase
updates or deletes an audit row. That is an application-level guarantee. Anyone
with direct database access can still alter the table. The audit screen says so.
The records are **not** independently tamper-proof, and nothing here claims they
are.

**"Suggestions are explainable."** Every suggestion stores the evidence, the
score components, the rule version and the record versions it was computed
against, and the UI shows them before the approve button. The score is a
**ranking**, not a probability, and is never presented as a confidence.

**"The assistant cannot modify data."** True because no write tool exists, not
because of a prompt instruction. Adding one would be a code change with a review
attached.

**"Duplicate events do not duplicate financial effects."** Guaranteed by unique
database constraints — `(organizationId, postingEventId)` on journal entries,
`(bankAccountId, providerKey, externalId)` on transactions,
`(organizationId, generationKey)` on charges — not by application-level checks
that a race could slip past.

**"Concurrent actions preserve balances."** Guaranteed by transaction-scoped
advisory locks on `(propertyId, period)` plus version compare-and-swap on the
contended rows. `apps/api/test/integration/concurrency.test.ts` runs the races
and asserts the outcomes.

---

## Known gaps a reviewer may notice

- The migration baseline is **derived** from `schema.prisma` on first setup
  rather than hand-written and committed, and verified for drift immediately
  afterwards. This is deliberate: a hand-written baseline can silently diverge
  from the schema it is meant to produce.
- The web application covers the ten screens in the specification. It is not a
  complete product: bulk actions, saved views, CSV export from every table and
  keyboard shortcuts beyond focus management are not implemented.
- Lease and tenant records are read-only in the UI. They are created by the seed.
  The financial workflows the specification is about — generation,
  reconciliation, close — are fully interactive.
- There is no rate limiting on the API beyond query complexity and depth limits.
  A deployment would put one in front.
