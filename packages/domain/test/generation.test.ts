import { describe, expect, it } from 'vitest';
import {
  buildGenerationKey,
  previewCharges,
  type LeaseGenerationInput,
  type ScheduleVersionInput,
} from '../src/charges/generation';
import { money } from '../src/money/money';
import { ChargeType, LeaseStatus, ScheduleFrequency } from '../src/types';

const usd = (cents: number) => money(cents, 'USD');

function schedule(overrides: Partial<ScheduleVersionInput> = {}): ScheduleVersionInput {
  return {
    scheduleId: 'sch_rent',
    scheduleVersionId: 'sv_1',
    versionNumber: 1,
    chargeType: ChargeType.BASE_RENT,
    frequency: ScheduleFrequency.MONTHLY,
    amount: usd(310_000),
    effectiveFrom: '2025-01-01',
    effectiveTo: null,
    dueDayOfMonth: 1,
    prorate: true,
    description: 'Base rent',
    ...overrides,
  };
}

function lease(overrides: Partial<LeaseGenerationInput> = {}): LeaseGenerationInput {
  return {
    leaseId: 'lease_1',
    organizationId: 'org_1',
    propertyId: 'prop_1',
    unitId: 'unit_1',
    tenantId: 'tenant_1',
    status: LeaseStatus.ACTIVE,
    currency: 'USD',
    paymentReference: 'RW-1001',
    termStart: '2025-01-01',
    termEnd: null,
    schedules: [schedule()],
    ...overrides,
  };
}

function run(leases: LeaseGenerationInput[], existing: string[] = [], period = '2026-03') {
  return previewCharges({
    period,
    propertyId: 'prop_1',
    currency: 'USD',
    leases,
    existingGenerationKeys: new Set(existing),
  });
}

describe('charge generation', () => {
  it('generates one full-month charge for an active lease', () => {
    const preview = run([lease()]);
    expect(preview.proposed).toHaveLength(1);
    const charge = preview.proposed[0]!;
    expect(charge.amount.cents).toBe(310_000);
    expect(charge.serviceStart).toBe('2026-03-01');
    expect(charge.serviceEnd).toBe('2026-03-31');
    expect(charge.dueDate).toBe('2026-03-01');
    expect(charge.period).toBe('2026-03');
    expect(preview.totalAmount.cents).toBe(310_000);
    expect(preview.leaseCount).toBe(1);
  });

  it('clamps a due day beyond the length of the month', () => {
    const preview = run([lease({ schedules: [schedule({ dueDayOfMonth: 31 })] })], [], '2026-02');
    expect(preview.proposed[0]!.dueDate).toBe('2026-02-28');
  });

  it('prorates a lease that starts mid-period', () => {
    const preview = run([lease({ termStart: '2026-03-17' })]);
    const charge = preview.proposed[0]!;
    // 15 of 31 days: 2026-03-17 through 2026-03-31 inclusive.
    expect(charge.serviceStart).toBe('2026-03-17');
    expect(charge.calculation.occupiedDays).toBe(15);
    expect(charge.amount.cents).toBe(150_000);
    expect(preview.warnings.some((w) => w.code === 'PARTIAL_PERIOD')).toBe(true);
  });

  it('prorates a lease that ends mid-period', () => {
    const preview = run([lease({ termEnd: '2026-03-15' })]);
    const charge = preview.proposed[0]!;
    expect(charge.serviceEnd).toBe('2026-03-15');
    expect(charge.calculation.occupiedDays).toBe(15);
    expect(charge.amount.cents).toBe(150_000);
  });

  it('generates nothing for a lease whose term does not reach the period', () => {
    expect(run([lease({ termEnd: '2026-01-31' })]).proposed).toHaveLength(0);
    expect(run([lease({ termStart: '2026-05-01' })]).proposed).toHaveLength(0);
  });

  it('skips a draft or terminated lease and says why', () => {
    const preview = run([lease({ status: LeaseStatus.TERMINATED })]);
    expect(preview.proposed).toHaveLength(0);
    expect(preview.warnings[0]!.code).toBe('LEASE_NOT_ACTIVE');
  });

  it('splits the month when a rent change takes effect mid-period', () => {
    const preview = run([
      lease({
        schedules: [
          schedule({
            scheduleVersionId: 'sv_1',
            versionNumber: 1,
            amount: usd(310_000),
            effectiveFrom: '2025-01-01',
            effectiveTo: '2026-03-15',
          }),
          schedule({
            scheduleVersionId: 'sv_2',
            versionNumber: 2,
            amount: usd(620_000),
            effectiveFrom: '2026-03-16',
            effectiveTo: null,
          }),
        ],
      }),
    ]);

    expect(preview.proposed).toHaveLength(2);
    const [first, second] = preview.proposed;
    expect(first!.serviceStart).toBe('2026-03-01');
    expect(first!.serviceEnd).toBe('2026-03-15');
    expect(first!.amount.cents).toBe(150_000); // 310000 x 15/31
    expect(first!.scheduleVersionNumber).toBe(1);

    expect(second!.serviceStart).toBe('2026-03-16');
    expect(second!.serviceEnd).toBe('2026-03-31');
    expect(second!.amount.cents).toBe(320_000); // 620000 x 16/31
    expect(second!.scheduleVersionNumber).toBe(2);
  });

  it('truncates an overlapping schedule version and warns', () => {
    const preview = run([
      lease({
        schedules: [
          schedule({ versionNumber: 1, effectiveFrom: '2025-01-01', effectiveTo: '2026-12-31' }),
          schedule({
            scheduleVersionId: 'sv_2',
            versionNumber: 2,
            amount: usd(400_000),
            effectiveFrom: '2026-03-16',
            effectiveTo: null,
          }),
        ],
      }),
    ]);
    expect(preview.warnings.some((w) => w.code === 'SCHEDULE_OVERLAP')).toBe(true);
    expect(preview.proposed).toHaveLength(2);
    expect(preview.proposed[0]!.serviceEnd).toBe('2026-03-15');
    expect(preview.proposed[1]!.serviceStart).toBe('2026-03-16');
  });

  it('is idempotent: an already-generated key is skipped, not duplicated', () => {
    const first = run([lease()]);
    const key = first.proposed[0]!.generationKey;
    expect(key).toBe(
      buildGenerationKey('lease_1', 'sch_rent', '2026-03', '2026-03-01', '2026-03-31'),
    );

    const second = run([lease()], [key]);
    expect(second.proposed).toHaveLength(0);
    expect(second.skipped).toEqual([key]);
    expect(second.leaseCount).toBe(1);
  });

  it('generates a one-time fee only in the period containing its date', () => {
    const oneTime = schedule({
      scheduleId: 'sch_fee',
      scheduleVersionId: 'sv_fee',
      chargeType: ChargeType.ONE_TIME,
      frequency: ScheduleFrequency.ONE_TIME,
      amount: usd(25_000),
      effectiveFrom: '2026-03-12',
      effectiveTo: null,
      description: 'Late fee',
    });

    const inPeriod = run([lease({ schedules: [oneTime] })]);
    expect(inPeriod.proposed).toHaveLength(1);
    expect(inPeriod.proposed[0]!.amount.cents).toBe(25_000);
    expect(inPeriod.proposed[0]!.serviceStart).toBe('2026-03-12');
    expect(inPeriod.proposed[0]!.serviceEnd).toBe('2026-03-12');
    expect(inPeriod.proposed[0]!.dueDate).toBe('2026-03-12');

    const otherPeriod = run([lease({ schedules: [oneTime] })], [], '2026-04');
    expect(otherPeriod.proposed).toHaveLength(0);
  });

  it('skips a zero-amount schedule with a warning', () => {
    const preview = run([lease({ schedules: [schedule({ amount: usd(0) })] })]);
    expect(preview.proposed).toHaveLength(0);
    expect(preview.warnings[0]!.code).toBe('ZERO_AMOUNT_SKIPPED');
  });

  it('warns when an active lease has no schedule at all', () => {
    const preview = run([lease({ schedules: [] })]);
    expect(preview.warnings[0]!.code).toBe('NO_EFFECTIVE_SCHEDULE');
  });

  it('produces a stable order so preview and commit agree row for row', () => {
    const leases = [
      lease({ leaseId: 'lease_b' }),
      lease({ leaseId: 'lease_a' }),
      lease({ leaseId: 'lease_c' }),
    ];
    const a = run(leases);
    const b = run([...leases].reverse());
    expect(a.proposed.map((c) => c.generationKey)).toEqual(b.proposed.map((c) => c.generationKey));
    expect(a.proposed.map((c) => c.leaseId)).toEqual(['lease_a', 'lease_b', 'lease_c']);
  });

  it('rejects a lease belonging to another property', () => {
    expect(() => run([lease({ propertyId: 'prop_other' })])).toThrow(/another property/);
  });

  it('rejects a lease in a different currency', () => {
    expect(() => run([lease({ currency: 'EUR' })])).toThrow(/EUR/);
  });

  it('charges the full amount for a partial month when proration is disabled', () => {
    const preview = run([
      lease({ termStart: '2026-03-17', schedules: [schedule({ prorate: false })] }),
    ]);
    expect(preview.proposed[0]!.amount.cents).toBe(310_000);
  });
});
