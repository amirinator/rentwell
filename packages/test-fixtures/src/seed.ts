/**
 * Deterministic demonstration data.
 *
 * Everything here is synthetic: the tenants, the addresses, the email addresses
 * and the payments are generated from a seed string and correspond to nothing
 * real. No production data of any kind is committed to this repository.
 *
 * The data set is built to make the specification's scenarios reachable in the
 * running application rather than only in tests. After a seed you can find, by
 * name, a payment that matches exactly, one that pays half, one that pays two
 * invoices at once, one that overpays, one with no usable reference, one the
 * provider later reverses, and a file that has already been imported.
 *
 * A reset produces byte-identical data, so the demo guide can name specific
 * references and stay true.
 */

import argon2 from 'argon2';
import {
  ChargeType,
  LeaseStatus,
  Role,
  ScheduleFrequency,
  addDays,
  addMonths,
  buildChargePostedEntry,
  money,
  periodEnd,
  periodStart,
  previewCharges,
  type LeaseGenerationInput,
  type LocalDate,
  type PeriodKey,
} from '@rentwell/domain';
import {
  centsToDb,
  ensureLedgerAccounts,
  localDateToDb,
  toJson,
  writeJournalEntry,
  type PrismaClient,
  centsFromDb,
} from '@rentwell/database';
import { SeededRandom, address, companyName, personName, propertyName } from './random';
import { clearAll, createPaymentScenarios, openPeriods } from './scenarios';

export const DEFAULT_SEED = 'rentwell-demo';

/** Every demo account uses this password. Stated in the README; not a secret. */
export const DEMO_PASSWORD = 'rentwell-demo-2026';

/** Periods the demo covers. The last one is left open for the close walkthrough. */
export const DEMO_PERIODS: readonly PeriodKey[] = ['2026-01', '2026-02', '2026-03'];

export interface SeedOptions {
  readonly seed?: string;
  readonly propertyCount?: number;
  readonly leaseCount?: number;
  /** Removes existing data first. Required for a repeatable reset. */
  readonly reset?: boolean;
  readonly log?: (message: string) => void;
}

export interface SeedSummary {
  readonly organizations: number;
  readonly properties: number;
  readonly units: number;
  readonly tenants: number;
  readonly leases: number;
  readonly charges: number;
  readonly transactions: number;
  readonly scenarios: Record<string, string>;
}

interface DemoUser {
  readonly email: string;
  readonly displayName: string;
  readonly role: (typeof Role)[keyof typeof Role];
  /** When set, the membership is scoped to these property codes. */
  readonly propertyCodes?: readonly string[];
}

const PRIMARY_USERS: readonly DemoUser[] = [
  { email: 'admin@rentwell.example', displayName: 'Ada Okonkwo', role: Role.ORG_ADMIN },
  {
    email: 'controller@rentwell.example',
    displayName: 'Clara Nwosu',
    role: Role.PORTFOLIO_CONTROLLER,
  },
  {
    email: 'accountant@rentwell.example',
    displayName: 'Anil Raghavan',
    role: Role.ACCOUNTANT,
    // Assigned to a slice of the portfolio, so the scoping rules are visible in
    // the demo rather than only in tests.
    propertyCodes: ['RW-001', 'RW-002', 'RW-003', 'RW-004', 'RW-005', 'RW-006'],
  },
  {
    email: 'manager@rentwell.example',
    displayName: 'Mira Delacroix',
    role: Role.PROPERTY_MANAGER,
    propertyCodes: ['RW-001', 'RW-002'],
  },
  { email: 'auditor@rentwell.example', displayName: 'Tomas Berg', role: Role.AUDITOR },
];

const SECOND_ORG_USERS: readonly DemoUser[] = [
  {
    email: 'admin@northharbour.example',
    displayName: 'Iris Bramley',
    role: Role.ORG_ADMIN,
  },
  {
    email: 'accountant@northharbour.example',
    displayName: 'Owen Marsh',
    role: Role.ACCOUNTANT,
  },
];

export async function seed(prisma: PrismaClient, options: SeedOptions = {}): Promise<SeedSummary> {
  const log = options.log ?? (() => undefined);
  const random = new SeededRandom(options.seed ?? DEFAULT_SEED);
  const propertyCount = options.propertyCount ?? 28;
  const leaseTarget = options.leaseCount ?? 150;

  if (options.reset) {
    log('Clearing existing data...');
    await clearAll(prisma);
  }

  log('Creating organizations and users...');
  const passwordHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id });

  const primary = await prisma.organization.create({
    data: { slug: 'rentwell', name: 'Rentwell Property Group', currency: 'USD' },
  });
  const secondary = await prisma.organization.create({
    data: { slug: 'north-harbour', name: 'North Harbour Estates', currency: 'USD' },
  });

  await prisma.$transaction(async (tx) => {
    await ensureLedgerAccounts(tx, primary.id);
    await ensureLedgerAccounts(tx, secondary.id);
  });

  log(`Creating ${propertyCount} properties...`);
  const properties = await createProperties(prisma, primary.id, propertyCount, random);
  // The second organization exists so cross-organization isolation can be
  // demonstrated with real records on both sides, not just an empty tenant.
  const otherProperties = await createProperties(prisma, secondary.id, 2, random, 900);

  await createUsers(prisma, primary.id, PRIMARY_USERS, passwordHash, properties);
  await createUsers(prisma, secondary.id, SECOND_ORG_USERS, passwordHash, otherProperties);

  log('Creating units, tenants and leases...');
  const portfolio = await createPortfolio(prisma, primary.id, properties, leaseTarget, random);
  await createPortfolio(prisma, secondary.id, otherProperties, 6, random);

  log('Generating charges...');
  const chargeCount = await generateChargesForPeriods(prisma, primary.id, properties, DEMO_PERIODS);
  await generateChargesForPeriods(prisma, secondary.id, otherProperties, DEMO_PERIODS);

  log('Creating payments and reconciliation scenarios...');
  const scenarios = await createPaymentScenarios(prisma, primary.id, properties, random);

  log('Opening accounting periods...');
  await openPeriods(prisma, primary.id, properties);
  await openPeriods(prisma, secondary.id, otherProperties);

  const transactions = await prisma.bankTransaction.count();

  const summary: SeedSummary = {
    organizations: 2,
    properties: properties.length + otherProperties.length,
    units: portfolio.units,
    tenants: portfolio.tenants,
    leases: portfolio.leases,
    charges: chargeCount,
    transactions,
    scenarios,
  };

  log('Seed complete.');
  return summary;
}

// --------------------------------------------------------------------------
// Organizations, users and properties
// --------------------------------------------------------------------------

export interface SeededProperty {
  id: string;
  code: string;
  currency: string;
  timezone: string;
  bankAccountId: string;
}

async function createProperties(
  prisma: PrismaClient,
  organizationId: string,
  count: number,
  random: SeededRandom,
  codeOffset = 0,
): Promise<SeededProperty[]> {
  const created: SeededProperty[] = [];

  for (let index = 0; index < count; index += 1) {
    const place = address(random);
    const code = `RW-${String(index + 1 + codeOffset).padStart(3, '0')}`;

    const property = await prisma.property.create({
      data: {
        organizationId,
        code,
        name: propertyName(random, index + codeOffset),
        addressLine1: place.line1,
        city: place.city,
        region: place.region,
        postalCode: place.postalCode,
        countryCode: 'US',
        timezone: place.timezone,
        currency: 'USD',
        status: 'ACTIVE',
        defaultDueDay: 1,
      },
    });

    const bankAccount = await prisma.bankAccount.create({
      data: {
        organizationId,
        propertyId: property.id,
        label: `${code} operating account`,
        // Last four digits only; a full account number is never stored.
        maskedNumber: String(random.int(1000, 9999)),
        currency: 'USD',
        providerAccountId: `acct_${code.toLowerCase()}`,
        isActive: true,
      },
    });

    created.push({
      id: property.id,
      code,
      currency: 'USD',
      timezone: place.timezone,
      bankAccountId: bankAccount.id,
    });
  }

  return created;
}

async function createUsers(
  prisma: PrismaClient,
  organizationId: string,
  users: readonly DemoUser[],
  passwordHash: string,
  properties: readonly SeededProperty[],
): Promise<void> {
  const byCode = new Map(properties.map((property) => [property.code, property.id]));

  for (const user of users) {
    const created = await prisma.user.create({
      data: { email: user.email, displayName: user.displayName, passwordHash },
    });

    const membership = await prisma.membership.create({
      data: { userId: created.id, organizationId, role: user.role, status: 'ACTIVE' },
    });

    for (const code of user.propertyCodes ?? []) {
      const propertyId = byCode.get(code);
      if (!propertyId) continue;
      await prisma.propertyAssignment.create({
        data: { membershipId: membership.id, propertyId },
      });
    }
  }
}

// --------------------------------------------------------------------------
// Units, tenants and leases
// --------------------------------------------------------------------------

async function createPortfolio(
  prisma: PrismaClient,
  organizationId: string,
  properties: readonly SeededProperty[],
  leaseTarget: number,
  random: SeededRandom,
): Promise<{ units: number; tenants: number; leases: number }> {
  let unitCount = 0;
  let tenantCount = 0;
  let leaseCount = 0;
  let referenceCounter = 1000;

  for (const property of properties) {
    const unitsHere = random.int(5, 9);

    for (let unitIndex = 0; unitIndex < unitsHere; unitIndex += 1) {
      const floor = String(Math.floor(unitIndex / 3) + 1);
      const identifier = `${floor}0${(unitIndex % 3) + 1}`;

      const unit = await prisma.unit.create({
        data: {
          organizationId,
          propertyId: property.id,
          identifier,
          rentableArea: random.int(600, 6_400),
          floor,
          occupancy: 'VACANT',
        },
      });
      unitCount += 1;

      // Not every unit is let, so the portfolio has realistic vacancy and the
      // close checklist has something to be quiet about.
      if (leaseCount >= leaseTarget || random.chance(0.18)) continue;

      referenceCounter += 1;
      const reference = `RW-${referenceCounter}`;

      const tenant = await prisma.tenant.create({
        data: {
          organizationId,
          kind: random.chance(0.85) ? 'ORGANIZATION' : 'INDIVIDUAL',
          displayName: random.chance(0.85) ? companyName(random) : personName(random),
          contactEmail: `ap+${reference.toLowerCase()}@example.invalid`,
          contactPhone: `555-01${String(random.int(10, 99))}`,
          paymentReference: reference,
          isActive: true,
        },
      });
      tenantCount += 1;

      // Terms start before the demo window so every lease bills a full month,
      // except the handful below that deliberately start mid-period.
      const startsMidPeriod = random.chance(0.08);
      const termStart: LocalDate = startsMidPeriod
        ? `2026-02-${String(random.int(8, 20)).padStart(2, '0')}`
        : addMonths('2026-01-01', -random.int(3, 30));
      const termEnd: LocalDate | null = random.chance(0.75)
        ? addMonths(termStart, random.int(24, 84))
        : null;

      const lease = await prisma.lease.create({
        data: {
          organizationId,
          propertyId: property.id,
          unitId: unit.id,
          tenantId: tenant.id,
          reference: `LSE-${reference}`,
          status: LeaseStatus.ACTIVE,
          currency: 'USD',
          termStart: localDateToDb(termStart),
          termEnd: termEnd ? localDateToDb(termEnd) : null,
          paymentReference: reference,
        },
      });
      leaseCount += 1;

      await prisma.unit.update({ where: { id: unit.id }, data: { occupancy: 'OCCUPIED' } });

      const baseRent = random.dollars(1_800, 14_000);
      await createSchedule(prisma, organizationId, lease.id, {
        chargeType: ChargeType.BASE_RENT,
        description: 'Base rent',
        amountCents: baseRent,
        effectiveFrom: termStart,
        // A few leases carry a mid-demo rent increase, which is what makes the
        // split-month proration case reachable from the UI.
        stepUp: random.chance(0.12)
          ? {
              from: '2026-03-16' as LocalDate,
              amountCents: Math.round((baseRent * 1.08) / 100) * 100,
            }
          : null,
      });

      if (random.chance(0.7)) {
        await createSchedule(prisma, organizationId, lease.id, {
          chargeType: ChargeType.OPERATING,
          description: 'Operating charges (CAM)',
          amountCents: random.dollars(200, 1_800),
          effectiveFrom: termStart,
          stepUp: null,
        });
      }
    }
  }

  return { units: unitCount, tenants: tenantCount, leases: leaseCount };
}

async function createSchedule(
  prisma: PrismaClient,
  organizationId: string,
  leaseId: string,
  spec: {
    chargeType: (typeof ChargeType)[keyof typeof ChargeType];
    description: string;
    amountCents: number;
    effectiveFrom: LocalDate;
    stepUp: { from: LocalDate; amountCents: number } | null;
  },
): Promise<void> {
  const schedule = await prisma.chargeSchedule.create({
    data: {
      organizationId,
      leaseId,
      chargeType: spec.chargeType,
      frequency: ScheduleFrequency.MONTHLY,
      description: spec.description,
      isActive: true,
    },
  });

  await prisma.chargeScheduleVersion.create({
    data: {
      scheduleId: schedule.id,
      versionNumber: 1,
      amountCents: centsToDb(spec.amountCents),
      currency: 'USD',
      effectiveFrom: localDateToDb(spec.effectiveFrom),
      // An effective-dated version is closed the day before its successor
      // starts, which is exactly how an amendment is recorded.
      effectiveTo: spec.stepUp ? localDateToDb(addDays(spec.stepUp.from, -1)) : null,
      dueDayOfMonth: 1,
      prorate: true,
    },
  });

  if (spec.stepUp) {
    await prisma.chargeScheduleVersion.create({
      data: {
        scheduleId: schedule.id,
        versionNumber: 2,
        amountCents: centsToDb(spec.stepUp.amountCents),
        currency: 'USD',
        effectiveFrom: localDateToDb(spec.stepUp.from),
        effectiveTo: null,
        dueDayOfMonth: 1,
        prorate: true,
        note: 'Scheduled rent review',
      },
    });
  }
}

// --------------------------------------------------------------------------
// Charges
// --------------------------------------------------------------------------

/**
 * Generates charges through the real domain engine.
 *
 * The seed deliberately does not invent charge rows: it runs the same
 * `previewCharges` the application runs, so the demo data obeys every
 * proration and idempotency rule the tests assert. If generation is wrong, the
 * demo is visibly wrong too.
 */
async function generateChargesForPeriods(
  prisma: PrismaClient,
  organizationId: string,
  properties: readonly SeededProperty[],
  periods: readonly PeriodKey[],
): Promise<number> {
  let created = 0;

  for (const property of properties) {
    for (const period of periods) {
      const leases = await prisma.lease.findMany({
        where: {
          propertyId: property.id,
          status: { in: ['ACTIVE', 'EXPIRED'] },
          termStart: { lte: localDateToDb(periodEnd(period)) },
          OR: [{ termEnd: null }, { termEnd: { gte: localDateToDb(periodStart(period)) } }],
        },
        include: {
          tenant: { select: { paymentReference: true } },
          schedules: { include: { versions: { orderBy: { versionNumber: 'asc' } } } },
        },
        orderBy: { id: 'asc' },
      });

      if (leases.length === 0) continue;

      const existing = await prisma.charge.findMany({
        where: { propertyId: property.id, period },
        select: { generationKey: true },
      });

      const preview = previewCharges({
        period,
        propertyId: property.id,
        currency: 'USD',
        leases: leases.map((lease) => toGenerationInput(lease)),
        existingGenerationKeys: new Set(existing.map((row) => row.generationKey)),
      });

      if (preview.proposed.length === 0) continue;

      await prisma.$transaction(
        async (tx) => {
          const accountIds = await ensureLedgerAccounts(tx, organizationId);
          const postingDate = periodStart(period);

          for (const proposed of preview.proposed) {
            const charge = await tx.charge.create({
              data: {
                organizationId,
                propertyId: proposed.propertyId,
                leaseId: proposed.leaseId,
                tenantId: proposed.tenantId,
                scheduleId: proposed.scheduleId,
                scheduleVersionId: proposed.scheduleVersionId,
                generationKey: proposed.generationKey,
                type: proposed.type,
                status: 'POSTED',
                currency: proposed.currency,
                amountCents: centsToDb(proposed.amount.cents),
                openCents: centsToDb(proposed.amount.cents),
                serviceStart: localDateToDb(proposed.serviceStart),
                serviceEnd: localDateToDb(proposed.serviceEnd),
                dueDate: localDateToDb(proposed.dueDate),
                postingDate: localDateToDb(postingDate),
                period,
                description: proposed.description,
                calculation: toJson(proposed.calculation),
              },
              select: { id: true },
            });

            await writeJournalEntry(
              tx,
              buildChargePostedEntry({
                chargeId: charge.id,
                organizationId,
                propertyId: proposed.propertyId,
                tenantId: proposed.tenantId,
                leaseId: proposed.leaseId,
                chargeType: proposed.type,
                amount: proposed.amount,
                postingDate,
                serviceStart: proposed.serviceStart,
                description: proposed.description,
              }),
              accountIds,
              { createdByUserId: null, correlationId: 'seed' },
            );

            created += 1;
          }
        },
        { timeout: 120_000 },
      );
    }
  }

  return created;
}

function toGenerationInput(lease: {
  id: string;
  organizationId: string;
  propertyId: string;
  unitId: string;
  tenantId: string;
  status: string;
  currency: string;
  paymentReference: string | null;
  termStart: Date;
  termEnd: Date | null;
  tenant: { paymentReference: string | null } | null;
  schedules: {
    id: string;
    chargeType: string;
    frequency: string;
    description: string;
    isActive: boolean;
    versions: {
      id: string;
      versionNumber: number;
      amountCents: bigint;
      currency: string;
      effectiveFrom: Date;
      effectiveTo: Date | null;
      dueDayOfMonth: number;
      prorate: boolean;
    }[];
  }[];
}): LeaseGenerationInput {
  const toLocal = (value: Date): LocalDate => value.toISOString().slice(0, 10) as LocalDate;

  return {
    leaseId: lease.id,
    organizationId: lease.organizationId,
    propertyId: lease.propertyId,
    unitId: lease.unitId,
    tenantId: lease.tenantId,
    status: lease.status as LeaseGenerationInput['status'],
    currency: lease.currency.trim(),
    paymentReference: lease.paymentReference ?? lease.tenant?.paymentReference ?? null,
    termStart: toLocal(lease.termStart),
    termEnd: lease.termEnd ? toLocal(lease.termEnd) : null,
    schedules: lease.schedules
      .filter((schedule) => schedule.isActive)
      .flatMap((schedule) =>
        schedule.versions.map((version) => ({
          scheduleId: schedule.id,
          scheduleVersionId: version.id,
          versionNumber: version.versionNumber,
          chargeType:
            schedule.chargeType as LeaseGenerationInput['schedules'][number]['chargeType'],
          frequency: schedule.frequency as LeaseGenerationInput['schedules'][number]['frequency'],
          amount: money(centsFromDb(version.amountCents), version.currency.trim()),
          effectiveFrom: toLocal(version.effectiveFrom),
          effectiveTo: version.effectiveTo ? toLocal(version.effectiveTo) : null,
          dueDayOfMonth: version.dueDayOfMonth,
          prorate: version.prorate,
          description: schedule.description,
        })),
      ),
  };
}
