/**
 * Authorization helpers used by every resolver.
 *
 * These are plain functions rather than Nest guards on purpose. A guard runs
 * before the resolver and can only see its arguments; most decisions here need
 * the record — its organization, its property, its period — which is only known
 * after a read. Making the check a call inside the resolver keeps the check and
 * the thing being checked in the same place, where a reviewer can see both.
 */

import {
  DomainError,
  assertCan,
  assertPropertyAccess,
  assertSameOrganization,
  hasPropertyAccess,
  propertyScopeFilter,
  type AccessContext,
  type Action,
} from '@rentwell/domain';
import type { GqlContext } from './context';

/** Returns the principal, or throws UNAUTHENTICATED. */
export function principal(ctx: GqlContext): AccessContext {
  if (ctx.access === null) {
    throw new DomainError('UNAUTHENTICATED', 'Sign in to perform this action');
  }
  return ctx.access;
}

/** Authenticates and checks one action in a single call. */
export function authorize(ctx: GqlContext, action: Action): AccessContext {
  const access = principal(ctx);
  assertCan(access, action);
  return access;
}

/**
 * Authenticates, checks the action, and confirms access to the property.
 *
 * `property` is the record read from the database, not an id from the request:
 * the organization on the record is what proves the id belongs to the viewer.
 */
export function authorizeProperty(
  ctx: GqlContext,
  action: Action,
  property: { id: string; organizationId: string },
): AccessContext {
  const access = authorize(ctx, action);
  assertPropertyAccess(access, property);
  return access;
}

/**
 * Resolves the property id set a list query may span.
 *
 * `requested` narrows; it never widens. An accountant asking for a property
 * they are not assigned to gets PROPERTY_NOT_ASSIGNED rather than a silently
 * empty list, because silence looks like "there is nothing there".
 */
export function resolvePropertyScope(
  access: AccessContext,
  requested: readonly string[] | null | undefined,
): string[] | null {
  const allowed = propertyScopeFilter(access);

  if (!requested || requested.length === 0) return allowed;

  for (const propertyId of requested) {
    if (!hasPropertyAccess(access, propertyId)) {
      throw new DomainError(
        'PROPERTY_NOT_ASSIGNED',
        'You are not assigned to one of the requested properties',
        {
          details: { propertyId },
        },
      );
    }
  }

  return [...requested];
}

/** Prisma `where` fragment for a property scope. */
export function propertyScopeWhere(scope: string[] | null): Record<string, unknown> {
  return scope === null ? {} : { propertyId: { in: scope } };
}

/**
 * Loads a record through a loader and applies the organization check.
 *
 * Reports NOT_FOUND for both "does not exist" and "belongs to another
 * organization", so an identifier cannot be probed for existence across an
 * organization boundary.
 */
export async function loadInOrganization<T extends { id: string; organizationId: string }>(
  access: AccessContext,
  loader: { load(key: string): Promise<unknown> },
  id: string,
  entityName: string,
): Promise<T> {
  const row = (await loader.load(id)) as T | null;
  if (!row) throw new DomainError('NOT_FOUND', `${entityName} not found`, { details: { id } });
  assertSameOrganization(access, row, entityName);
  return row;
}

export { assertCan, assertPropertyAccess, assertSameOrganization };
