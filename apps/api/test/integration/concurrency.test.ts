/**
 * The guarantees that only a real database can demonstrate.
 *
 * Every test here is written against a property the specification states, and
 * each fails loudly if the corresponding index, lock or compare-and-swap is
 * removed. They are the reason the schema carries the unique indexes it does.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  PeriodStatus,
  buildChargePostedEntry,
  buildPaymentAllocatedEntry,
  buildPaymentReceivedEntry,
  money,
  netDebitMinusCredit,
} from '@rentwell/domain';
import {
  centsFromDb,
  centsToDb,
  claimIdempotencyKey,
  claimProcessedEvent,
  ensureLedgerAccounts,
  isUniqueViolation,
  localDateToDb,
  lockPeriod,
  lockPeriodForPosting,
  runInTransaction,
  toJson,
  writeJournalEntry,
} from '@rentwell/database';
import { prisma, resetDatabase } from './setup';

const PERIOD = '2026-03';
const POSTING_DATE = '2026-03-01';

interface Fixture {
  organizationId: string;
  otherOrganizationId: string;
  propertyId: string;
  leaseId: string;
  tenantId: string;
  bankAccountId: string;
  userId: string;
}

async function buildFixture(): Promise<Fixture> {
  const organization = await prisma.organization.create({
    data: { slug: `org-${Date.now()}`, name: 'Primary', currency: 'USD' },
  });
  const other = await prisma.organization.create({
    data: { slug: `other-${Date.now()}`, name: 'Other', currency: 'USD' },
  });

  await prisma.$transaction(async (tx) => {
    await ensureLedgerAccounts(tx, organization.id);
    await ensureLedgerAccounts(tx, other.id);
  });

  const user = await prisma.user.create({
    data: {
      email: `user-${Date.now()}@example.invalid`,
      displayName: 'Test Accountant',
      passwordHash: 'not-a-real-hash',
    },
  });

  const property = await prisma.property.create({
    data: {
      organizationId: organization.id,
      code: 'RW-001',
      name: 'Test Property',
      addressLine1: '1 Test Street',
      city: 'Portland',
      region: 'OR',
      postalCode: '97209',
      countryCode: 'US',
      timezone: 'America/Los_Angeles',
      currency: 'USD',
    },
  });

  const unit = await prisma.unit.create({
    data: {
      organizationId: organization.id,
      propertyId: property.id,
      identifier: '101',
      occupancy: 'OCCUPIED',
    },
  });

  const tenant = await prisma.tenant.create({
    data: {
      organizationId: organization.id,
      displayName: 'Meridian Analytics LLC',
      paymentReference: 'RW-1001',
    },
  });

  const lease = await prisma.lease.create({
    data: {
      organizationId: organization.id,
      propertyId: property.id,
      unitId: unit.id,
      tenantId: tenant.id,
      reference: 'LSE-RW-1001',
      status: 'ACTIVE',
      currency: 'USD',
      termStart: localDateToDb('2025-01-01'),
      paymentReference: 'RW-1001',
    },
  });

  const bankAccount = await prisma.bankAccount.create({
    data: {
      organizationId: organization.id,
      propertyId: property.id,
      label: 'Operating',
      maskedNumber: '4821',
      currency: 'USD',
      providerAccountId: 'acct_rw_001',
    },
  });

  return {
    organizationId: organization.id,
    otherOrganizationId: other.id,
    propertyId: property.id,
    leaseId: lease.id,
    tenantId: tenant.id,
    bankAccountId: bankAccount.id,
    userId: user.id,
  };
}

async function createCharge(fixture: Fixture, amountCents: number, generationKey: string) {
  return prisma.charge.create({
    data: {
      organizationId: fixture.organizationId,
      propertyId: fixture.propertyId,
      leaseId: fixture.leaseId,
      tenantId: fixture.tenantId,
      generationKey,
      type: 'BASE_RENT',
      status: 'POSTED',
      currency: 'USD',
      amountCents: centsToDb(amountCents),
      openCents: centsToDb(amountCents),
      serviceStart: localDateToDb('2026-03-01'),
      serviceEnd: localDateToDb('2026-03-31'),
      dueDate: localDateToDb('2026-03-01'),
      postingDate: localDateToDb(POSTING_DATE),
      period: PERIOD,
      description: 'March base rent',
      calculation: toJson({}),
    },
  });
}

async function createTransaction(fixture: Fixture, amountCents: number, externalId: string) {
  return prisma.bankTransaction.create({
    data: {
      organizationId: fixture.organizationId,
      propertyId: fixture.propertyId,
      bankAccountId: fixture.bankAccountId,
      source: 'CSV_IMPORT',
      providerKey: 'csv',
      externalId,
      direction: 'CREDIT',
      status: 'UNAPPLIED',
      currency: 'USD',
      amountCents: centsToDb(amountCents),
      postedDate: localDateToDb('2026-03-05'),
      postingDate: localDateToDb('2026-03-05'),
      period: PERIOD,
      reference: 'RW-1001',
    },
  });
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await buildFixture();
});

// --------------------------------------------------------------------------

describe('duplicate generation', () => {
  it('a repeated generation key cannot create a second charge', async () => {
    await createCharge(fixture, 310_000, 'lease|schedule|2026-03|2026-03-01|2026-03-31');

    // The same key again: the unique index is what makes generation idempotent.
    await expect(
      createCharge(fixture, 310_000, 'lease|schedule|2026-03|2026-03-01|2026-03-31'),
    ).rejects.toSatisfy(isUniqueViolation);

    expect(await prisma.charge.count()).toBe(1);
  });

  it('two concurrent generation attempts produce exactly one charge', async () => {
    const key = 'lease|schedule|2026-03|2026-03-01|2026-03-31';

    const results = await Promise.allSettled([
      createCharge(fixture, 310_000, key),
      createCharge(fixture, 310_000, key),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.charge.count()).toBe(1);
  });
});

describe('duplicate transaction ingestion', () => {
  it('the same external id on one account cannot create a second payment', async () => {
    await createTransaction(fixture, 310_000, 'EXT-1');

    await expect(createTransaction(fixture, 310_000, 'EXT-1')).rejects.toSatisfy(isUniqueViolation);

    expect(await prisma.bankTransaction.count()).toBe(1);
  });

  it('the same external id on a different account is a different payment', async () => {
    const second = await prisma.bankAccount.create({
      data: {
        organizationId: fixture.organizationId,
        propertyId: fixture.propertyId,
        label: 'Second account',
        maskedNumber: '9999',
        currency: 'USD',
      },
    });

    await createTransaction(fixture, 310_000, 'EXT-1');
    await prisma.bankTransaction.create({
      data: {
        organizationId: fixture.organizationId,
        propertyId: fixture.propertyId,
        bankAccountId: second.id,
        source: 'CSV_IMPORT',
        providerKey: 'csv',
        externalId: 'EXT-1',
        direction: 'CREDIT',
        currency: 'USD',
        amountCents: centsToDb(310_000),
        postedDate: localDateToDb('2026-03-05'),
        postingDate: localDateToDb('2026-03-05'),
        period: PERIOD,
      },
    });

    expect(await prisma.bankTransaction.count()).toBe(2);
  });
});

describe('post-once', () => {
  it('a repeated posting event writes one journal entry, not two', async () => {
    const charge = await createCharge(fixture, 310_000, 'gen-1');

    const entry = buildChargePostedEntry({
      chargeId: charge.id,
      organizationId: fixture.organizationId,
      propertyId: fixture.propertyId,
      tenantId: fixture.tenantId,
      leaseId: fixture.leaseId,
      chargeType: 'BASE_RENT',
      amount: money(310_000, 'USD'),
      postingDate: POSTING_DATE,
      serviceStart: '2026-03-01',
      description: 'March rent',
    });

    const first = await prisma.$transaction(async (tx) =>
      writeJournalEntry(tx, entry, await ensureLedgerAccounts(tx, fixture.organizationId)),
    );
    const second = await prisma.$transaction(async (tx) =>
      writeJournalEntry(tx, entry, await ensureLedgerAccounts(tx, fixture.organizationId)),
    );

    expect(first.created).toBe(true);
    // The second attempt reports "already posted" rather than failing or
    // posting again, which is what makes a redelivered event safe.
    expect(second.created).toBe(false);
    expect(second.entryId).toBe(first.entryId);
    expect(await prisma.journalEntry.count()).toBe(1);
  });

  it('every posted entry balances, and the whole ledger nets to zero', async () => {
    const charge = await createCharge(fixture, 310_000, 'gen-1');
    const transaction = await createTransaction(fixture, 310_000, 'EXT-1');

    await prisma.$transaction(async (tx) => {
      const accounts = await ensureLedgerAccounts(tx, fixture.organizationId);

      await writeJournalEntry(
        tx,
        buildChargePostedEntry({
          chargeId: charge.id,
          organizationId: fixture.organizationId,
          propertyId: fixture.propertyId,
          tenantId: fixture.tenantId,
          leaseId: fixture.leaseId,
          chargeType: 'BASE_RENT',
          amount: money(310_000, 'USD'),
          postingDate: POSTING_DATE,
          serviceStart: '2026-03-01',
          description: 'March rent',
        }),
        accounts,
      );

      await writeJournalEntry(
        tx,
        buildPaymentReceivedEntry({
          transactionId: transaction.id,
          organizationId: fixture.organizationId,
          propertyId: fixture.propertyId,
          amount: money(310_000, 'USD'),
          postingDate: '2026-03-05',
          valueDate: '2026-03-05',
          description: 'ACH receipt',
        }),
        accounts,
      );
    });

    const lines = await prisma.journalLine.findMany({
      select: { accountCode: true, debitCents: true, creditCents: true },
    });

    const net = netDebitMinusCredit(
      lines.map((line) => ({
        accountCode: line.accountCode,
        debitCents: centsFromDb(line.debitCents),
        creditCents: centsFromDb(line.creditCents),
      })),
    );

    expect(net).toBe(0);
  });
});

describe('concurrent allocation approval', () => {
  it('two approvals racing for the same balance: exactly one succeeds', async () => {
    const charge = await createCharge(fixture, 100_000, 'gen-1');
    const transaction = await createTransaction(fixture, 100_000, 'EXT-1');

    // Both readers see version 1 and both try to consume the whole balance.
    const attemptApproval = async (allocationTag: string): Promise<boolean> =>
      runInTransaction(
        prisma,
        async (tx) => {
          await lockPeriodForPosting(tx, fixture.organizationId, fixture.propertyId, PERIOD);

          const current = await tx.charge.findUniqueOrThrow({ where: { id: charge.id } });
          const open = centsFromDb(current.openCents);
          if (open < 100_000) return false;

          // Compare-and-swap on the version the reader saw.
          const updated = await tx.charge.updateMany({
            where: { id: charge.id, version: current.version },
            data: {
              allocatedCents: centsToDb(centsFromDb(current.allocatedCents) + 100_000),
              openCents: centsToDb(open - 100_000),
              status: 'SETTLED',
              version: { increment: 1 },
            },
          });
          if (updated.count === 0) return false;

          const allocation = await tx.allocation.create({
            data: {
              organizationId: fixture.organizationId,
              propertyId: fixture.propertyId,
              transactionId: transaction.id,
              chargeId: charge.id,
              amountCents: centsToDb(100_000),
              currency: 'USD',
              status: 'ACTIVE',
              postingDate: localDateToDb('2026-03-05'),
              period: PERIOD,
              approvedByUserId: fixture.userId,
              note: allocationTag,
            },
          });

          await writeJournalEntry(
            tx,
            buildPaymentAllocatedEntry({
              allocationId: allocation.id,
              transactionId: transaction.id,
              chargeId: charge.id,
              organizationId: fixture.organizationId,
              propertyId: fixture.propertyId,
              tenantId: fixture.tenantId,
              leaseId: fixture.leaseId,
              amount: money(100_000, 'USD'),
              postingDate: '2026-03-05',
              description: 'Allocation',
            }),
            await ensureLedgerAccounts(tx, fixture.organizationId),
          );

          return true;
        },
        { maxAttempts: 1 },
      ).catch(() => false);

    const [first, second] = await Promise.all([attemptApproval('A'), attemptApproval('B')]);

    // One winner, one loser. Never two.
    expect([first, second].filter(Boolean)).toHaveLength(1);

    const finalCharge = await prisma.charge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(centsFromDb(finalCharge.allocatedCents)).toBe(100_000);
    expect(centsFromDb(finalCharge.openCents)).toBe(0);
    expect(await prisma.allocation.count()).toBe(1);
  });
});

describe('close versus posting', () => {
  it('a posting cannot commit into a period that closed first', async () => {
    await prisma.accountingPeriod.create({
      data: {
        organizationId: fixture.organizationId,
        propertyId: fixture.propertyId,
        period: PERIOD,
        status: PeriodStatus.IN_REVIEW,
      },
    });

    // The close takes the period lock and commits.
    await runInTransaction(prisma, async (tx) => {
      const locked = await lockPeriod(tx, fixture.organizationId, fixture.propertyId, PERIOD);
      await tx.accountingPeriod.update({
        where: { id: locked.id },
        data: { status: PeriodStatus.CLOSED, closedAt: new Date(), version: { increment: 1 } },
      });
    });

    // A posting arriving afterwards takes the same lock, reads the committed
    // state, and is refused.
    await expect(
      runInTransaction(prisma, async (tx) => {
        await lockPeriodForPosting(tx, fixture.organizationId, fixture.propertyId, PERIOD);
        await createCharge(fixture, 100_000, 'late-charge');
      }),
    ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });

    expect(await prisma.charge.count()).toBe(0);
  });

  it('the period lock serialises a close and a posting whichever order they start in', async () => {
    await prisma.accountingPeriod.create({
      data: {
        organizationId: fixture.organizationId,
        propertyId: fixture.propertyId,
        period: PERIOD,
        status: PeriodStatus.IN_REVIEW,
      },
    });

    const posting = runInTransaction(prisma, async (tx) => {
      await lockPeriodForPosting(tx, fixture.organizationId, fixture.propertyId, PERIOD);
      await createCharge(fixture, 100_000, 'racing-charge');
      return 'posted';
    }).catch((error: { code?: string }) => error.code ?? 'failed');

    const closing = runInTransaction(prisma, async (tx) => {
      const locked = await lockPeriod(tx, fixture.organizationId, fixture.propertyId, PERIOD);
      await tx.accountingPeriod.update({
        where: { id: locked.id },
        data: { status: PeriodStatus.CLOSED, closedAt: new Date(), version: { increment: 1 } },
      });
      return 'closed';
    });

    const [postingResult, closingResult] = await Promise.all([posting, closing]);

    expect(closingResult).toBe('closed');

    // Either the posting won the lock and committed, or the close won and the
    // posting was refused. What must never happen is a charge existing in a
    // closed period.
    const charges = await prisma.charge.count();
    if (postingResult === 'PERIOD_CLOSED') {
      expect(charges).toBe(0);
    } else {
      expect(postingResult).toBe('posted');
      expect(charges).toBe(1);
    }
  });
});

describe('organization isolation', () => {
  it('a query scoped to one organization cannot see another one records', async () => {
    await createCharge(fixture, 100_000, 'gen-1');

    const visible = await prisma.charge.findMany({
      where: { organizationId: fixture.otherOrganizationId },
    });
    expect(visible).toHaveLength(0);

    // And the record is there when the correct organization asks.
    const own = await prisma.charge.findMany({ where: { organizationId: fixture.organizationId } });
    expect(own).toHaveLength(1);
  });

  it('an identifier from another organization does not resolve', async () => {
    const charge = await createCharge(fixture, 100_000, 'gen-1');

    const probed = await prisma.charge.findFirst({
      where: { id: charge.id, organizationId: fixture.otherOrganizationId },
    });

    // Reads as "not found", which is what the API reports, so an identifier
    // cannot be probed for existence across the boundary.
    expect(probed).toBeNull();
  });
});

describe('idempotency', () => {
  it('replays a completed result for the same key and input', async () => {
    const params = {
      organizationId: fixture.organizationId,
      operation: 'approveAllocations',
      key: 'key-1',
      input: { transactionId: 'txn-1', cents: 100_000 },
    };

    const first = await prisma.$transaction((tx) =>
      claimIdempotencyKey<{ ok: boolean }>(tx, params),
    );
    expect(first.kind).toBe('PROCEED');

    if (first.kind !== 'PROCEED') throw new Error('unreachable');

    await prisma.idempotencyRecord.update({
      where: { id: first.recordId },
      data: { status: 'COMPLETED', responseBody: toJson({ ok: true }), completedAt: new Date() },
    });

    const second = await prisma.$transaction((tx) =>
      claimIdempotencyKey<{ ok: boolean }>(tx, params),
    );
    expect(second).toEqual({ kind: 'REPLAY', response: { ok: true } });
  });

  it('rejects the same key with different input instead of replaying', async () => {
    const base = {
      organizationId: fixture.organizationId,
      operation: 'approveAllocations',
      key: 'key-2',
    };

    await prisma.$transaction((tx) =>
      claimIdempotencyKey(tx, { ...base, input: { cents: 100_000 } }),
    );

    // Replaying here would silently discard the second request's intent.
    await expect(
      prisma.$transaction((tx) => claimIdempotencyKey(tx, { ...base, input: { cents: 999 } })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('is scoped by organization and operation', async () => {
    const input = { cents: 100_000 };

    const a = await prisma.$transaction((tx) =>
      claimIdempotencyKey(tx, {
        organizationId: fixture.organizationId,
        operation: 'op',
        key: 'shared',
        input,
      }),
    );
    const b = await prisma.$transaction((tx) =>
      claimIdempotencyKey(tx, {
        organizationId: fixture.otherOrganizationId,
        operation: 'op',
        key: 'shared',
        input,
      }),
    );

    expect(a.kind).toBe('PROCEED');
    expect(b.kind).toBe('PROCEED');
  });
});

describe('consumer deduplication', () => {
  it('a redelivered event is claimed once', async () => {
    const first = await prisma.$transaction((tx) =>
      claimProcessedEvent(tx, 'webhook-processor', 'evt-1'),
    );
    const second = await prisma.$transaction((tx) =>
      claimProcessedEvent(tx, 'webhook-processor', 'evt-1'),
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('different consumers each process the same event once', async () => {
    const a = await prisma.$transaction((tx) => claimProcessedEvent(tx, 'consumer-a', 'evt-1'));
    const b = await prisma.$transaction((tx) => claimProcessedEvent(tx, 'consumer-b', 'evt-1'));

    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});

describe('posting rollback', () => {
  it('a failure part-way through leaves nothing behind', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const accounts = await ensureLedgerAccounts(tx, fixture.organizationId);
        const charge = await createChargeIn(tx, fixture, 100_000, 'gen-rollback');

        await writeJournalEntry(
          tx,
          buildChargePostedEntry({
            chargeId: charge.id,
            organizationId: fixture.organizationId,
            propertyId: fixture.propertyId,
            tenantId: fixture.tenantId,
            leaseId: fixture.leaseId,
            chargeType: 'BASE_RENT',
            amount: money(100_000, 'USD'),
            postingDate: POSTING_DATE,
            serviceStart: '2026-03-01',
            description: 'March rent',
          }),
          accounts,
        );

        throw new Error('simulated failure after posting');
      }),
    ).rejects.toThrow('simulated failure');

    // The charge and its entry commit together or not at all.
    expect(await prisma.charge.count()).toBe(0);
    expect(await prisma.journalEntry.count()).toBe(0);
    expect(await prisma.journalLine.count()).toBe(0);
  });
});

/** Charge creation inside a caller-supplied transaction. */
async function createChargeIn(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  fixtureRef: Fixture,
  amountCents: number,
  generationKey: string,
) {
  return tx.charge.create({
    data: {
      organizationId: fixtureRef.organizationId,
      propertyId: fixtureRef.propertyId,
      leaseId: fixtureRef.leaseId,
      tenantId: fixtureRef.tenantId,
      generationKey,
      type: 'BASE_RENT',
      status: 'POSTED',
      currency: 'USD',
      amountCents: centsToDb(amountCents),
      openCents: centsToDb(amountCents),
      serviceStart: localDateToDb('2026-03-01'),
      serviceEnd: localDateToDb('2026-03-31'),
      dueDate: localDateToDb('2026-03-01'),
      postingDate: localDateToDb(POSTING_DATE),
      period: PERIOD,
      description: 'March base rent',
      calculation: toJson({}),
    },
  });
}
