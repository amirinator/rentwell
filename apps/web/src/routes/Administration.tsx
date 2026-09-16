import { useQuery } from '@apollo/client';
import { MEMBERS } from '../graphql/operations';
import { useSession } from '../lib/session';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  StatusBadge,
  humanize,
} from '../components/ui';

/**
 * Administration.
 *
 * Read-only in version 1. The screen exists to make the access model visible —
 * who holds which role, and which properties each person is scoped to — because
 * "why can't I see that property" is the question this answers.
 *
 * The note about administrative access is not decoration: an organization
 * administrator manages people and integrations and deliberately holds no
 * financial approval authority, and stating that where roles are displayed is
 * the right place for it.
 */
export function Administration() {
  const { viewer } = useSession();
  const { data, loading, error, refetch } = useQuery(MEMBERS);

  const members = (data?.members ?? []) as Member[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-900">Administration</h1>
        <p className="text-sm text-ink-500">
          Membership and access for {viewer?.organization.name}.
        </p>
      </div>

      <Panel
        title="Members"
        description="Role decides which actions are permitted; property assignment decides which records they apply to."
      >
        {loading && members.length === 0 && <LoadingState />}
        {error && members.length === 0 && (
          <ErrorState message={error.message} onRetry={() => void refetch()} />
        )}
        {!loading && members.length === 0 && <EmptyState title="No members" />}

        {members.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Property scope</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td className="font-medium">{member.displayName}</td>
                  <td className="text-ink-600">{member.email}</td>
                  <td>{humanize(member.role)}</td>
                  <td>
                    <StatusBadge status={member.status} />
                  </td>
                  <td className="text-xs">
                    {isOrganizationScoped(member.role) ? (
                      <span className="text-ink-500">Entire organization</span>
                    ) : member.assignedProperties.length === 0 ? (
                      <span className="text-caution-800">
                        No properties assigned — this member sees nothing
                      </span>
                    ) : (
                      member.assignedProperties.map((property) => property.code).join(', ')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="What each role may do">
        <div className="space-y-3 p-4 text-sm">
          <RoleNote
            role="Organization administrator"
            summary="Manages users, roles, property assignments and integration settings."
            caveat="Holds no financial approval authority: it cannot generate charges, approve or reverse an allocation, resolve an exception, or close a period."
          />
          <RoleNote
            role="Portfolio controller"
            summary="Reviews portfolio totals, approves adjustments, and closes and reopens periods."
            caveat="The only role that can close a period or classify unapplied cash at close."
          />
          <RoleNote
            role="Accountant"
            summary="Generates charges, imports transactions, approves allocations and investigates exceptions."
            caveat="May start a period review but cannot close or reopen one."
          />
          <RoleNote
            role="Property manager"
            summary="Reviews assigned properties, tenants, balances and collection issues."
            caveat="Read-only, and limited to the properties they are assigned."
          />
          <RoleNote
            role="Auditor"
            summary="Reads financial records, journal entries, close snapshots and audit history."
            caveat="Writes nothing at all, including assistant runs."
          />
        </div>
      </Panel>

      <Panel title="Integrations">
        <div className="p-4 text-sm text-ink-700">
          <p>
            This build ships one banking adapter: a deterministic simulator. It produces duplicate
            deliveries, late arrivals, transient failures, out-of-order events and reversals from a
            fixed seed, so those failure modes can be exercised on demand without credentials.
          </p>
          <p className="mt-2 text-ink-500">
            Live banking connections are outside the public demonstration. Changing integration
            settings is not implemented in version 1.
          </p>
        </div>
      </Panel>
    </div>
  );
}

function RoleNote({ role, summary, caveat }: { role: string; summary: string; caveat: string }) {
  return (
    <div className="rounded border border-ink-200 p-3">
      <p className="font-medium text-ink-900">{role}</p>
      <p className="mt-0.5 text-ink-700">{summary}</p>
      <p className="mt-1 text-xs text-ink-500">{caveat}</p>
    </div>
  );
}

function isOrganizationScoped(role: string): boolean {
  return role === 'ORG_ADMIN' || role === 'PORTFOLIO_CONTROLLER' || role === 'AUDITOR';
}

interface Member {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  assignedProperties: { id: string; code: string; name: string }[];
}
