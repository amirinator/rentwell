/**
 * Authorization model.
 *
 * Access is decided by five inputs, in this order: organization membership,
 * membership status, role, property assignment, and — for financial writes —
 * the state of the accounting period. Every GraphQL resolver, background job,
 * file download and assistant tool call goes through `assertCan` or
 * `assertPropertyAccess`; there is no code path that consults only the role.
 *
 * Two deliberate properties of this matrix:
 *
 *  - An organization administrator manages people and integrations. It holds no
 *    financial approval authority: it cannot generate charges, approve an
 *    allocation, or close a period.
 *  - An auditor reads everything financial and writes nothing.
 */

import {
  Role,
  MembershipStatus,
  type MembershipStatus as MembershipStatusValue,
  type Role as RoleValue,
} from '../types';
import { DomainError } from '../errors';

export type Action =
  // Administration
  | 'org:manage_members'
  | 'org:manage_integrations'
  | 'org:read_settings'
  // Portfolio records
  | 'property:read'
  | 'property:manage'
  | 'tenant:read'
  | 'tenant:manage'
  | 'lease:read'
  | 'lease:manage'
  // Billing
  | 'charge:read'
  | 'charge:generate'
  | 'charge:credit'
  // Ingestion
  | 'import:read'
  | 'import:create'
  | 'import:confirm'
  | 'import:cancel'
  | 'import:download_file'
  | 'transaction:read'
  // Reconciliation
  | 'suggestion:read'
  | 'suggestion:regenerate'
  | 'allocation:approve'
  | 'allocation:reverse'
  | 'exception:read'
  | 'exception:assign'
  | 'exception:resolve'
  | 'exception:classify_unapplied'
  // Accounting control
  | 'period:start_review'
  | 'period:close'
  | 'period:reopen'
  | 'journal:read'
  | 'close_snapshot:read'
  // Cross-cutting
  | 'dashboard:read'
  | 'audit:read'
  | 'assistant:invoke';

const READ_ONLY_FINANCIAL: readonly Action[] = [
  'property:read',
  'tenant:read',
  'lease:read',
  'charge:read',
  'import:read',
  'transaction:read',
  'suggestion:read',
  'exception:read',
  'journal:read',
  'close_snapshot:read',
  'dashboard:read',
];

const ROLE_ACTIONS: Readonly<Record<RoleValue, readonly Action[]>> = Object.freeze({
  [Role.ORG_ADMIN]: [
    'org:manage_members',
    'org:manage_integrations',
    'org:read_settings',
    'property:read',
    'property:manage',
    'tenant:read',
    'tenant:manage',
    'lease:read',
    'dashboard:read',
    'audit:read',
    // Deliberately absent: charge:generate, charge:credit, allocation:approve,
    // allocation:reverse, exception:resolve, period:close, period:reopen.
  ],
  [Role.PORTFOLIO_CONTROLLER]: [
    ...READ_ONLY_FINANCIAL,
    'org:read_settings',
    'audit:read',
    'charge:credit',
    'allocation:approve',
    'allocation:reverse',
    'exception:assign',
    'exception:resolve',
    'exception:classify_unapplied',
    'period:start_review',
    'period:close',
    'period:reopen',
    'assistant:invoke',
  ],
  [Role.ACCOUNTANT]: [
    ...READ_ONLY_FINANCIAL,
    'audit:read',
    'charge:generate',
    'charge:credit',
    'import:create',
    'import:confirm',
    'import:cancel',
    'import:download_file',
    'suggestion:regenerate',
    'allocation:approve',
    'allocation:reverse',
    'exception:assign',
    'exception:resolve',
    'period:start_review',
    'assistant:invoke',
    // Deliberately absent: period:close and period:reopen.
  ],
  [Role.PROPERTY_MANAGER]: [
    'property:read',
    'tenant:read',
    'lease:read',
    'charge:read',
    'transaction:read',
    'exception:read',
    'dashboard:read',
    'close_snapshot:read',
  ],
  [Role.AUDITOR]: [
    ...READ_ONLY_FINANCIAL,
    'audit:read',
    'org:read_settings',
    // Auditors read the assistant's stored runs but never start one, because a
    // run is a write to AssistantRun and consumes provider budget.
  ],
});

/** Roles whose visibility spans the whole organization, not an assignment list. */
const ORGANIZATION_SCOPED_ROLES: ReadonlySet<RoleValue> = new Set<RoleValue>([
  Role.ORG_ADMIN,
  Role.PORTFOLIO_CONTROLLER,
  Role.AUDITOR,
]);

/** The authenticated principal, resolved once per request or job. */
export interface AccessContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: RoleValue;
  readonly membershipStatus: MembershipStatusValue;
  /** Property ids explicitly assigned. Ignored for organization-scoped roles. */
  readonly assignedPropertyIds: ReadonlySet<string>;
  /** Correlates authorization decisions with the request in the audit log. */
  readonly correlationId?: string;
  /**
   * True only for background workers acting on behalf of the system. A system
   * context bypasses the property-assignment list (a worker has no assignments)
   * but is still bound by its role's action list and by its organization.
   */
  readonly isSystem?: boolean;
}

/**
 * Actions a background worker must never take, whatever role it borrows.
 *
 * Workers ingest payments and post the resulting journal entries, because those
 * follow mechanically from data the system already accepted. Every decision
 * that commits a person's judgement — approving an allocation, reversing one,
 * resolving an exception, issuing a credit, moving a period — needs a named
 * human actor in the audit trail, so it is denied here even when the borrowed
 * role permits it.
 */
const SYSTEM_DENIED_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'allocation:approve',
  'allocation:reverse',
  'charge:credit',
  'exception:resolve',
  'exception:classify_unapplied',
  'period:start_review',
  'period:close',
  'period:reopen',
  'org:manage_members',
  'org:manage_integrations',
  'import:download_file',
]);

export function allowedActions(role: RoleValue): readonly Action[] {
  return ROLE_ACTIONS[role] ?? [];
}

export function can(context: AccessContext, action: Action): boolean {
  if (context.membershipStatus !== MembershipStatus.ACTIVE) return false;
  if (context.isSystem === true && SYSTEM_DENIED_ACTIONS.has(action)) return false;
  return allowedActions(context.role).includes(action);
}

export function assertCan(context: AccessContext, action: Action): void {
  if (context.membershipStatus !== MembershipStatus.ACTIVE) {
    throw new DomainError('FORBIDDEN', 'This membership is suspended', {
      details: { userId: context.userId, action },
    });
  }
  if (!can(context, action)) {
    throw new DomainError('FORBIDDEN', `Role ${context.role} is not permitted to ${action}`, {
      details: { role: context.role, action },
    });
  }
}

export function isOrganizationScoped(role: RoleValue): boolean {
  return ORGANIZATION_SCOPED_ROLES.has(role);
}

export function hasPropertyAccess(context: AccessContext, propertyId: string): boolean {
  if (context.membershipStatus !== MembershipStatus.ACTIVE) return false;
  if (context.isSystem === true) return true;
  if (isOrganizationScoped(context.role)) return true;
  return context.assignedPropertyIds.has(propertyId);
}

/**
 * Property-level gate.
 *
 * Reports NOT_FOUND rather than FORBIDDEN when the record belongs to another
 * organization, so an identifier from a second organization cannot be used to
 * probe for existence. Within the caller's own organization, an unassigned
 * property reports PROPERTY_NOT_ASSIGNED, which is actionable.
 */
export function assertPropertyAccess(
  context: AccessContext,
  property: { id: string; organizationId: string },
): void {
  if (property.organizationId !== context.organizationId) {
    throw new DomainError('NOT_FOUND', 'Property not found', {
      details: { propertyId: property.id },
    });
  }
  if (!hasPropertyAccess(context, property.id)) {
    throw new DomainError('PROPERTY_NOT_ASSIGNED', 'You are not assigned to this property', {
      details: { propertyId: property.id, userId: context.userId },
    });
  }
}

/**
 * Organization gate for any record carrying an organizationId. Also reports
 * NOT_FOUND on mismatch, for the same reason as above.
 */
export function assertSameOrganization(
  context: AccessContext,
  record: { organizationId: string },
  entityName = 'Record',
): void {
  if (record.organizationId !== context.organizationId) {
    throw new DomainError('NOT_FOUND', `${entityName} not found`, {
      details: { entity: entityName },
    });
  }
}

/**
 * The property filter to apply to a list query. `null` means no restriction
 * (organization-scoped role); an empty array means the user sees nothing.
 */
export function propertyScopeFilter(context: AccessContext): string[] | null {
  if (context.isSystem === true) return null;
  if (isOrganizationScoped(context.role)) return null;
  return [...context.assignedPropertyIds].sort();
}

/** Actions that mutate financial records. Used to gate on period state. */
const FINANCIAL_WRITE_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'charge:generate',
  'charge:credit',
  'allocation:approve',
  'allocation:reverse',
  'import:confirm',
]);

export function isFinancialWrite(action: Action): boolean {
  return FINANCIAL_WRITE_ACTIONS.has(action);
}

/** Convenience context for background jobs acting on behalf of the system. */
export function systemContext(organizationId: string): AccessContext {
  return {
    userId: 'system',
    organizationId,
    // Workers post charges and receipts the same way an accountant would, but
    // never approve allocations: approval always needs a named human actor.
    role: Role.ACCOUNTANT,
    membershipStatus: MembershipStatus.ACTIVE,
    assignedPropertyIds: new Set<string>(),
    isSystem: true,
  };
}
