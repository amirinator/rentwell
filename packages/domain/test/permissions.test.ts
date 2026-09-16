import { describe, expect, it } from 'vitest';
import {
  assertCan,
  assertPropertyAccess,
  assertSameOrganization,
  can,
  hasPropertyAccess,
  isOrganizationScoped,
  propertyScopeFilter,
  systemContext,
  type AccessContext,
} from '../src/access/permissions';
import { MembershipStatus, Role } from '../src/types';
import { expectDomainError } from './helpers';

function context(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    userId: 'user_1',
    organizationId: 'org_1',
    role: Role.ACCOUNTANT,
    membershipStatus: MembershipStatus.ACTIVE,
    assignedPropertyIds: new Set(['prop_1']),
    ...overrides,
  };
}

describe('role capabilities', () => {
  it('lets an accountant run the reconciliation workflow', () => {
    const accountant = context({ role: Role.ACCOUNTANT });
    expect(can(accountant, 'charge:generate')).toBe(true);
    expect(can(accountant, 'import:confirm')).toBe(true);
    expect(can(accountant, 'allocation:approve')).toBe(true);
    expect(can(accountant, 'exception:resolve')).toBe(true);
    expect(can(accountant, 'assistant:invoke')).toBe(true);
  });

  it('does not let an accountant close or reopen a period', () => {
    const accountant = context({ role: Role.ACCOUNTANT });
    expect(can(accountant, 'period:close')).toBe(false);
    expect(can(accountant, 'period:reopen')).toBe(false);
    expect(can(accountant, 'period:start_review')).toBe(true);
  });

  it('gives an organization administrator no financial approval authority', () => {
    const admin = context({ role: Role.ORG_ADMIN });
    expect(can(admin, 'org:manage_members')).toBe(true);
    expect(can(admin, 'org:manage_integrations')).toBe(true);

    expect(can(admin, 'charge:generate')).toBe(false);
    expect(can(admin, 'charge:credit')).toBe(false);
    expect(can(admin, 'allocation:approve')).toBe(false);
    expect(can(admin, 'allocation:reverse')).toBe(false);
    expect(can(admin, 'exception:resolve')).toBe(false);
    expect(can(admin, 'period:close')).toBe(false);
    expect(can(admin, 'period:reopen')).toBe(false);
  });

  it('lets only a controller close and reopen periods', () => {
    const controller = context({ role: Role.PORTFOLIO_CONTROLLER });
    expect(can(controller, 'period:close')).toBe(true);
    expect(can(controller, 'period:reopen')).toBe(true);
    expect(can(controller, 'exception:classify_unapplied')).toBe(true);
  });

  it('makes an auditor strictly read-only', () => {
    const auditor = context({ role: Role.AUDITOR });
    expect(can(auditor, 'journal:read')).toBe(true);
    expect(can(auditor, 'audit:read')).toBe(true);
    expect(can(auditor, 'close_snapshot:read')).toBe(true);

    expect(can(auditor, 'allocation:approve')).toBe(false);
    expect(can(auditor, 'charge:generate')).toBe(false);
    expect(can(auditor, 'exception:resolve')).toBe(false);
    expect(can(auditor, 'assistant:invoke')).toBe(false);
    expect(can(auditor, 'import:create')).toBe(false);
  });

  it('restricts a property manager to reading their properties', () => {
    const manager = context({ role: Role.PROPERTY_MANAGER });
    expect(can(manager, 'property:read')).toBe(true);
    expect(can(manager, 'charge:read')).toBe(true);
    expect(can(manager, 'allocation:approve')).toBe(false);
    expect(can(manager, 'journal:read')).toBe(false);
    expect(can(manager, 'import:create')).toBe(false);
  });

  it('denies everything to a suspended membership', () => {
    const suspended = context({
      role: Role.PORTFOLIO_CONTROLLER,
      membershipStatus: MembershipStatus.SUSPENDED,
    });
    expect(can(suspended, 'dashboard:read')).toBe(false);
    expect(hasPropertyAccess(suspended, 'prop_1')).toBe(false);
    expectDomainError(() => assertCan(suspended, 'dashboard:read'), 'FORBIDDEN');
  });
});

describe('property scoping', () => {
  it('limits an accountant to assigned properties', () => {
    const accountant = context({ role: Role.ACCOUNTANT, assignedPropertyIds: new Set(['prop_1']) });
    expect(hasPropertyAccess(accountant, 'prop_1')).toBe(true);
    expect(hasPropertyAccess(accountant, 'prop_2')).toBe(false);
    expect(propertyScopeFilter(accountant)).toEqual(['prop_1']);
  });

  it('gives organization-scoped roles the whole portfolio', () => {
    for (const role of [Role.ORG_ADMIN, Role.PORTFOLIO_CONTROLLER, Role.AUDITOR]) {
      const principal = context({ role, assignedPropertyIds: new Set() });
      expect(isOrganizationScoped(role)).toBe(true);
      expect(hasPropertyAccess(principal, 'prop_9')).toBe(true);
      expect(propertyScopeFilter(principal)).toBeNull();
    }
  });

  it('reports an unassigned property in the same organization as unassigned', () => {
    expectDomainError(
      () => assertPropertyAccess(context(), { id: 'prop_2', organizationId: 'org_1' }),
      'PROPERTY_NOT_ASSIGNED',
    );
  });

  it('reports another organization property as not found, never as forbidden', () => {
    // Returning FORBIDDEN here would confirm that the identifier exists.
    expectDomainError(
      () => assertPropertyAccess(context(), { id: 'prop_x', organizationId: 'org_2' }),
      'NOT_FOUND',
    );
    expectDomainError(
      () => assertSameOrganization(context(), { organizationId: 'org_2' }, 'Charge'),
      'NOT_FOUND',
    );
  });

  it('allows access to an assigned property in the same organization', () => {
    expect(() =>
      assertPropertyAccess(context(), { id: 'prop_1', organizationId: 'org_1' }),
    ).not.toThrow();
  });
});

describe('system context', () => {
  it('reaches every property but still cannot approve an allocation', () => {
    const system = systemContext('org_1');
    expect(hasPropertyAccess(system, 'prop_any')).toBe(true);
    expect(propertyScopeFilter(system)).toBeNull();
    expect(can(system, 'charge:generate')).toBe(true);
    expect(can(system, 'transaction:read')).toBe(true);

    // Decisions that commit a person's judgement need a named human actor, so
    // the worker is denied them even though an accountant may perform them.
    expect(can(system, 'allocation:approve')).toBe(false);
    expect(can(system, 'allocation:reverse')).toBe(false);
    expect(can(system, 'exception:resolve')).toBe(false);
    expect(can(system, 'charge:credit')).toBe(false);
    expect(can(system, 'period:close')).toBe(false);
  });

  it('is still bound to one organization', () => {
    expectDomainError(
      () => assertSameOrganization(systemContext('org_1'), { organizationId: 'org_2' }),
      'NOT_FOUND',
    );
  });
});
