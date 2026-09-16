# Rentwell

Commercial real estate financial operations: lease receivables, payment
reconciliation, exception investigation and month-end close.

The central workflow is

```
lease schedule → charge generation → payment ingestion → reconciliation
              → exception resolution → month-end close
```

Every record in this repository is synthetic. No production data of any kind is
committed here.

---

## What this is

A finance team reconciling commercial rent usually works across spreadsheets,
bank exports and a property system that does not talk to either. Payments arrive
without reliable references, one transfer covers three invoices, a tenant pays
half, a file gets imported twice, and by month-end nobody can reconstruct who
approved which correction.

Rentwell puts that work in one place and makes the financial guarantees
explicit:

- **Money is exact.** Integer minor units end to end, decimal arithmetic for
  every intermediate, rounded once at the point a value becomes a charge line.
  No binary floating point touches a monetary value anywhere in the codebase.
- **Repetition is free.** A retried request, a redelivered event and a
  double-clicked button converge on one charge, one payment, one journal entry.
  Idempotency comes from database constraints, not from hoping.
- **Concurrency is decided, not raced.** A posting cannot commit into a period
  that closed a microsecond earlier. Two people approving the same suggestion
  cannot both succeed.
- **The subledger proves itself.** Every entry balances, receivables derived
  from charge records are compared against receivables derived from journal
  lines, and the close blocks if they disagree.
- **Nothing disappears quietly.** Corrections are compensating records, not
  edits. Closing an exception cannot make a discrepancy vanish.

The AI assistant is read-only. It explains what the records show and cites them;
it cannot approve, post, resolve or close anything, because no tool exists that
would let it.

---

## Running it

You need Docker and Node 20+. Nothing else, and no credentials or paid services.

```bash
cp .env.example .env
corepack enable && corepack prepare pnpm@9.12.0 --activate
pnpm install

docker compose up -d postgres redis minio minio-init

pnpm db:setup     # derives the baseline migration, applies it, verifies no drift
pnpm seed:reset   # deterministic demonstration data

pnpm dev          # API on :4000, worker, web on :5173
```

Then open <http://localhost:5173>.

The seed prints the accounts it created and the reconciliation scenarios to look
for. Every account uses the password `rentwell-demo-2026`:

| Account                           | Role                       | What it can do                                                                           |
| --------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| `admin@rentwell.example`          | Organization administrator | Manages people and integrations. Deliberately holds **no** financial approval authority. |
| `controller@rentwell.example`     | Portfolio controller       | Sees the whole portfolio. The only role that closes and reopens periods.                 |
| `accountant@rentwell.example`     | Accountant                 | Generates charges, imports, approves allocations. Scoped to six properties.              |
| `manager@rentwell.example`        | Property manager           | Read-only, two properties.                                                               |
| `auditor@rentwell.example`        | Auditor                    | Reads everything financial, writes nothing.                                              |
| `accountant@northharbour.example` | A second organization      | For checking isolation from the other side.                                              |

To run everything in containers instead:

```bash
docker compose --profile full up --build
```

---

## Where to look first

If you are reviewing this and have twenty minutes, the four files that carry the
most of the design are:

| File                                                                                                       | Why                                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`packages/domain/src/money/decimal.ts`](packages/domain/src/money/decimal.ts)                             | Why money never touches a float, and where the single rounding step happens.                                   |
| [`packages/database/src/locks.ts`](packages/database/src/locks.ts)                                         | The close-versus-posting race, and the lock ordering that settles it.                                          |
| [`packages/domain/src/matching/engine.ts`](packages/domain/src/matching/engine.ts)                         | How a suggestion is produced, scored and made explainable — and why the score is a ranking, not a probability. |
| [`apps/api/src/reconciliation/allocations.service.ts`](apps/api/src/reconciliation/allocations.service.ts) | The five protections applied, in order, before money moves.                                                    |

Then [`docs/architecture.md`](docs/architecture.md) for how the pieces fit, and
[`docs/financial-model.md`](docs/financial-model.md) for the posting rules and
the invariants.

---

## Layout

```
apps/
  api/        NestJS + Apollo Server. Every financial write path.
  worker/     BullMQ consumers: imports, provider sync, suggestions, outbox dispatch.
  web/        React + Apollo Client. Ten screens.
packages/
  domain/     Pure financial logic. No I/O, no framework, no database.
  database/   Prisma schema, money and date marshalling, period locks, outbox.
  graphql/    The SDL, its scalars, and the shared TypeScript contract.
  integrations/ CSV parsing, the banking provider contract, its simulator, object storage.
  observability/ Logging, metrics, tracing, health.
  test-fixtures/ Deterministic synthetic data.
```

`packages/domain` deliberately has no dependencies on anything else in the
workspace. The rules that decide money are provable without standing up a stack,
and `pnpm --filter @rentwell/domain test` runs them in a couple of seconds.

---

## Testing

```bash
pnpm test:unit          # domain, integrations, GraphQL contract, enum parity
pnpm test:integration   # against a real PostgreSQL: concurrency, isolation, idempotency
pnpm test:worker        # crash recovery, redelivery, retry exhaustion
pnpm test:e2e           # browser, against a real API and worker
```

The integration tests are the ones worth reading. They prove properties of the
_database_ — that two concurrent approvals cannot both succeed, that a posting
cannot race past a close, that a repeated external id cannot create a second
payment — which a mocked client would assert nothing about.

CI runs type checks, lint, format, the schema-drift check and the full
correctness suite on every pull request.
