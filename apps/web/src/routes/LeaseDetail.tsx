import { useQuery } from '@apollo/client';
import { Link, useParams } from 'react-router-dom';
import { LEASE_DETAIL } from '../graphql/operations';
import {
  Amount,
  DefinitionRow,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  StatusBadge,
  formatDate,
  formatInstant,
  humanize,
  type Money,
} from '../components/ui';

/**
 * Lease detail.
 *
 * The schedule table is the interesting part: charge generation reads
 * effective-dated versions, so showing every version with its own date range
 * is what lets an accountant see why a particular month billed what it did.
 */
export function LeaseDetail() {
  const { leaseId } = useParams<{ leaseId: string }>();
  const { data, loading, error, refetch } = useQuery(LEASE_DETAIL, {
    variables: { id: leaseId },
    skip: !leaseId,
  });

  const lease = data?.lease as LeaseShape | undefined;

  if (loading && !lease)
    return (
      <Panel>
        <LoadingState />
      </Panel>
    );
  if (error && !lease) {
    return (
      <Panel>
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      </Panel>
    );
  }
  if (!lease)
    return (
      <Panel>
        <EmptyState title="Lease not found" />
      </Panel>
    );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-900">{lease.reference}</h1>
        <p className="text-sm text-ink-500">
          {lease.tenant.displayName} ·{' '}
          <Link to={`/properties/${lease.property.id}`} className="text-accent-700 hover:underline">
            {lease.property.code}
          </Link>{' '}
          unit {lease.unit.identifier}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Lease">
          <dl>
            <DefinitionRow term="Status">
              <StatusBadge status={lease.status} />
            </DefinitionRow>
            <DefinitionRow term="Term start">{formatDate(lease.termStart)}</DefinitionRow>
            <DefinitionRow term="Term end">
              {lease.termEnd ? formatDate(lease.termEnd) : 'Open-ended'}
            </DefinitionRow>
            <DefinitionRow term="Currency">{lease.currency}</DefinitionRow>
            <DefinitionRow term="Record version">{lease.version}</DefinitionRow>
          </dl>
        </Panel>

        <Panel title="Tenant">
          <dl>
            <DefinitionRow term="Name">{lease.tenant.displayName}</DefinitionRow>
            <DefinitionRow term="Payment reference">
              <code className="rounded bg-ink-100 px-1 py-0.5 text-xs">
                {lease.paymentReference ?? lease.tenant.paymentReference ?? '—'}
              </code>
            </DefinitionRow>
            <DefinitionRow term="Contact">{lease.tenant.contactEmail ?? '—'}</DefinitionRow>
          </dl>
          <p className="border-t border-ink-200 px-4 py-2 text-xs text-ink-500">
            The payment reference is what the matching engine compares against a bank reference.
            Keeping it current is the single biggest lever on automatic matching.
          </p>
        </Panel>

        <Panel title="Balance">
          <dl>
            <DefinitionRow term="Outstanding">
              <Amount value={lease.outstandingBalance} emphasis="strong" />
            </DefinitionRow>
          </dl>
        </Panel>
      </div>

      <Panel
        title="Charge schedules"
        description="Each version is effective for a date range. Generation uses the version effective during the service period, which is why a mid-month change splits the month into two charges."
      >
        {lease.schedules.length === 0 ? (
          <EmptyState
            title="No schedules"
            description="This lease will not generate any charges until a schedule is added."
          />
        ) : (
          lease.schedules.map((schedule) => (
            <div key={schedule.id} className="border-b border-ink-200 last:border-b-0">
              <div className="flex items-center justify-between px-4 py-2">
                <div>
                  <p className="text-sm font-medium text-ink-900">{schedule.description}</p>
                  <p className="text-xs text-ink-500">
                    {humanize(schedule.chargeType)} · {humanize(schedule.frequency)}
                  </p>
                </div>
                <StatusBadge
                  status={schedule.isActive ? 'ACTIVE' : 'INACTIVE'}
                  tone={schedule.isActive ? 'positive' : 'neutral'}
                />
              </div>

              <table className="data-table">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Effective from</th>
                    <th>Effective to</th>
                    <th className="text-right">Amount</th>
                    <th className="text-right">Due day</th>
                    <th>Prorate</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.versions.map((version) => (
                    <tr key={version.id}>
                      <td className="tabular">{version.versionNumber}</td>
                      <td>{formatDate(version.effectiveFrom)}</td>
                      <td>
                        {version.effectiveTo ? formatDate(version.effectiveTo) : 'Open-ended'}
                      </td>
                      <td className="text-right">
                        <Amount value={version.amount} />
                      </td>
                      <td className="tabular text-right">{version.dueDayOfMonth}</td>
                      <td>{version.prorate ? 'Yes' : 'No'}</td>
                      <td className="text-xs text-ink-600">{version.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </Panel>

      <Panel
        title="Amendments"
        description="Amendments affect future generation. A charge that has already been posted is corrected with a credit adjustment, never by editing it."
      >
        {lease.amendments.length === 0 ? (
          <EmptyState title="No amendments recorded" />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Effective</th>
                <th>Summary</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {lease.amendments.map((amendment) => (
                <tr key={amendment.id}>
                  <td>{formatDate(amendment.effectiveOn)}</td>
                  <td>{amendment.summary}</td>
                  <td className="text-ink-600">{formatInstant(amendment.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

interface LeaseShape {
  id: string;
  reference: string;
  status: string;
  currency: string;
  termStart: string;
  termEnd: string | null;
  paymentReference: string | null;
  version: number;
  outstandingBalance: Money;
  property: { id: string; code: string; name: string };
  unit: { id: string; identifier: string };
  tenant: {
    id: string;
    displayName: string;
    paymentReference: string | null;
    contactEmail: string | null;
  };
  schedules: {
    id: string;
    chargeType: string;
    frequency: string;
    description: string;
    isActive: boolean;
    versions: {
      id: string;
      versionNumber: number;
      effectiveFrom: string;
      effectiveTo: string | null;
      dueDayOfMonth: number;
      prorate: boolean;
      note: string | null;
      amount: Money;
    }[];
  }[];
  amendments: { id: string; summary: string; effectiveOn: string; createdAt: string }[];
}
