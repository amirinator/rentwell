# Financial model

How Rentwell represents money, what it posts, and what it guarantees.

---

## 1. Money

### Representation

Money is an integer number of minor units plus its currency:

```ts
interface Money {
  readonly cents: number; // signed, exact
  readonly currency: string; // ISO 4217, uppercase
}
```

Two decisions here, both deliberate.

**The currency is never implicit.** `add(usd, eur)` throws
`CURRENCY_MISMATCH` rather than producing a plausible-looking wrong number. A
bare `number` would let a EUR payment settle a USD invoice with no complaint.

**The storage type is `BIGINT`, not `INTEGER`.** A 32-bit column tops out at
21,474,836.47 in a two-decimal currency, which a portfolio-level aggregate
exceeds. It is not `NUMERIC`, because an integer cannot acquire a fractional
part through a careless operation. Every value crossing the boundary is checked
against `Number.MAX_SAFE_INTEGER` and throws rather than truncating.

### Arithmetic

No binary floating point touches a monetary value. Intermediate calculations —
proration, percentage splits, remainders — run through a BigInt-backed
fixed-point `Decimal`, and are rounded **exactly once**, at the point a value
becomes a persisted charge line or allocation amount.

The lint configuration blocks `Math.round` and `Number.parseFloat` outside
tests, with a message pointing at the money helpers, because those two calls are
how float arithmetic gets reintroduced by accident.

### Proration

The configured policy is `ACTUAL_DAYS_IN_MONTH`:

```
charge = monthly amount × occupied calendar days ÷ days in that calendar month
```

Days are counted inclusively: 2026-03-01 through 2026-03-15 is 15 of March's 31
days. The multiplication happens first and the division second, so the only
inexact step is a single high-precision division, and rounding happens once at
the end.

Worked example, $3,100.00 for 15 of 31 days:

```
310000 × 15        = 4650000        (exact, scale 2)
4650000 ÷ 31       = 150000.000000  (scale 12)
round to cents     = 150000         = $1,500.00 exactly
```

Every charge stores the inputs (`occupiedDays`, `daysInPeriod`,
`scheduledAmountCents`), the unrounded result and the rounding mode, so the
figure can be reproduced from the record. `recomputeFromDetail` does exactly
that, and the audit explorer shows it.

### Distributing a remainder

When one amount is split across several charges, `allocateProportionally`
distributes the rounding remainder by largest fractional part, ties broken by
lowest index. The parts always sum exactly to the total. Without this, a
three-way split of $10.00 loses a cent.

---

## 2. Dates

Three concepts, never conflated:

| Concept           | Type                       | Meaning                                                                                                                           |
| ----------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Business date     | `LocalDate` (`YYYY-MM-DD`) | The calendar day something happened, in the property's own timezone. Service periods, due dates, value dates. No time, no offset. |
| Instant           | `DateTime` (UTC)           | When the system recorded it. Every `createdAt`.                                                                                   |
| Accounting period | `PeriodKey` (`YYYY-MM`)    | The reporting bucket a posting belongs to. Derived from the posting date, never from the instant.                                 |

Converting an instant to a business date requires a timezone, which always comes
from the property. There is no ambient local timezone anywhere in the codebase.

This matters concretely: a payment at 03:30 UTC on 15 March is still 14 March in
Portland. Reading a `@db.Date` column with `getFullYear()` would shift the day
for any server west of Greenwich, so every read goes through `localDateFromDb`,
which reads UTC components only.

### Which date decides the period

| Event               | Posting date                                                               | Why                                                                                                   |
| ------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Charge posted       | First day of the period it bills                                           | A March charge generated on 2 April belongs to March. Using "today" would defeat accrual.             |
| Payment received    | The payment's own posted date                                              | Ties cash to the day it moved.                                                                        |
| Payment allocated   | The payment's posted date                                                  | Keeps the receipt and the settlement in the same period.                                              |
| Credit adjustment   | Today if today is in the charge's period, else the last day of that period | A late correction lands in the period being corrected. If that period is closed, the lock refuses it. |
| Allocation reversal | Today if in the allocation's period, else its first day                    | The reversal cancels the original inside one period rather than moving a balance between months.      |

---

## 3. The subledger

Five accounts. This is a receivables subledger, not a general ledger: no tax, no
bank reconciliation account, no statements.

| Account                 | Normal balance | Holds                                           |
| ----------------------- | -------------- | ----------------------------------------------- |
| Accounts receivable     | Debit          | Billed and not yet settled                      |
| Rental income           | Credit         | Base rent earned in the service period          |
| Operating charge income | Credit         | Recoverable operating charges and one-time fees |
| Cash clearing           | Debit          | Funds received into a property account          |
| Unapplied cash          | Credit         | Received but not yet matched to a charge        |

### Posting rules

| Event             | Debit                       | Credit                  |
| ----------------- | --------------------------- | ----------------------- |
| Rent charge       | Accounts receivable         | Rental income           |
| Operating charge  | Accounts receivable         | Operating charge income |
| Payment received  | Cash clearing               | Unapplied cash          |
| Payment allocated | Unapplied cash              | Accounts receivable     |
| Charge credit     | The relevant income account | Accounts receivable     |

Reversals post the opposite entry, linked to the original by
`reversesPostingEventId`. Nothing is edited or deleted.

**Why a receipt lands in unapplied cash rather than reducing receivables
directly:** money received is a liability to the tenant until it is matched to
something they owe. Crediting receivables on receipt would make a tenant who
overpaid by $500 appear to owe -$500, which is neither true nor useful. The
two-step model is also what makes unapplied cash a reportable figure the close
checklist can ask about.

### Worked example

March rent of $3,100, paid in full on 4 March:

```
CHARGE_POSTED:chg_1        Dr Accounts receivable  3100.00
                           Cr Rental income                 3100.00

PAYMENT_RECEIVED:txn_1     Dr Cash clearing        3100.00
                           Cr Unapplied cash                3100.00

PAYMENT_ALLOCATED:alloc_1  Dr Unapplied cash       3100.00
                           Cr Accounts receivable           3100.00
```

Afterwards: receivables 0, unapplied cash 0, rental income 3100 credit, cash
clearing 3100 debit. If the tenant had paid $3,350, unapplied cash would sit at
$250 credit — visible, reportable, and something the close asks a controller to
acknowledge.

---

## 4. Invariants

Each of these is enforced somewhere specific, and each has a test that fails if
the enforcement is removed.

| Invariant                                                   | Enforced by                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Every journal entry balances                                | `assertBalanced`, called by every builder and again by `writeJournalEntry`              |
| Each business event posts at most once                      | Unique index on `(organizationId, postingEventId)`                                      |
| Posted entries are immutable through the application        | No update or delete on `JournalEntry` or `JournalLine` anywhere in the codebase         |
| Money is integer cents in storage                           | `BIGINT` columns; the enum-parity test asserts no money column is `Float` or `Decimal`  |
| No binary floating point in calculations                    | `Decimal` for intermediates; lint rule on `Math.round` and `Number.parseFloat`          |
| Business date, posting date and period stored separately    | Distinct columns on every posting record                                                |
| Dashboard balances agree with journal-derived balances      | The close checklist computes receivables two independent ways and blocks if they differ |
| Corrections preserve source and reversal references         | `AllocationReversal.allocationId`, `JournalEntry.reversesPostingEventId`                |
| Active allocations never exceed a payment or charge balance | `planAllocation`, re-run under the period lock against freshly read rows                |
| An allocation is reversed at most once                      | Unique index on `AllocationReversal.allocationId`                                       |

### The cross-check that matters most

The close checklist derives outstanding receivables twice:

- from charge rows: `SUM(amountCents − allocatedCents − creditedCents)`
- from journal lines: `SUM(debit) − SUM(credit)` on accounts receivable

They are computed from different tables by different code. If they disagree, the
close is blocked with `SUMMARY_DISAGREES_WITH_SUBLEDGER`. Two independent
derivations agreeing is the system's own evidence that the operational records
and the subledger tell the same story; computing both the same way would prove
nothing.

There is also a maintained `openCents` column on `Charge`, kept in step by every
write path, so "still outstanding" is an indexable predicate. It is a third
derivation, and the integration suite asserts it equals the subtraction.

---

## 5. Version 1 limitations

- One currency and one accounting policy. Currency is explicit everywhere and
  cross-currency operations are rejected, not converted.
- Partial reversal of an allocation is not supported. A smaller correction is a
  full reversal followed by a new allocation, so no two records claim the same
  cents.
- `pendingApprovalCount` in the close checklist is always zero: version 1
  approves allocations directly rather than routing them to a second approver.
  The blocker remains in the domain model for the maker/checker flow a later
  version would add.
- `activePostingJobCount` is always zero: every posting happens inside a request
  or inside an outbox consumer, so undispatched outbox events are the complete
  in-flight signal.
