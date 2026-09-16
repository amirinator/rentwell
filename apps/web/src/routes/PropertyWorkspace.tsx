import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { Link, useParams } from 'react-router-dom';
import {
  GENERATE_CHARGES,
  PREVIEW_CHARGES,
  PROPERTY_DETAIL,
  RECEIVABLES,
} from '../graphql/operations';
import { defaultPeriod, useFilters, withFilters } from '../hooks/useFilters';
import { useSession } from '../lib/session';
import { useToast } from '../components/Toast';
import {
  Amount,
  Button,
  DefinitionRow,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  StatusBadge,
  formatDate,
  humanize,
  type Money,
} from '../components/ui';
import { Pager } from './PortfolioOverview';

export function PropertyWorkspace() {
  const { propertyId } = useParams<{ propertyId: string }>();
  const { filters, setFilters } = useFilters({ period: defaultPeriod() });

  const { data, loading, error, refetch } = useQuery(PROPERTY_DETAIL, {
    variables: { id: propertyId, period: filters.period },
    skip: !propertyId,
  });

  const property = data?.property as PropertyShape | undefined;

  if (loading && !property)
    return (
      <Panel>
        <LoadingState />
      </Panel>
    );
  if (error && !property) {
    return (
      <Panel>
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      </Panel>
    );
  }
  if (!property || !propertyId)
    return (
      <Panel>
        <EmptyState title="Property not found" />
      </Panel>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">
            {property.code} — {property.name}
          </h1>
          <p className="text-sm text-ink-500">
            {property.addressLine1}, {property.city} {property.region} {property.postalCode} ·{' '}
            {property.timezone}
          </p>
        </div>
        <label className="block">
          <span className="field-label">Accounting period</span>
          <input
            type="month"
            className="input mt-1 w-40"
            value={filters.period}
            onChange={(event) => setFilters({ period: event.target.value })}
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Panel title="Position" className="lg:col-span-1">
          <dl>
            <DefinitionRow term="Units">{property.unitCount}</DefinitionRow>
            <DefinitionRow term="Active leases">{property.activeLeaseCount}</DefinitionRow>
            <DefinitionRow term="Outstanding">
              <Amount value={property.outstandingReceivables} />
            </DefinitionRow>
            <DefinitionRow term="Unapplied cash">
              <Amount value={property.unappliedCash} showZeroAs="—" />
            </DefinitionRow>
            <DefinitionRow term={`Period ${filters.period}`}>
              {property.period ? <StatusBadge status={property.period.status} /> : '—'}
            </DefinitionRow>
          </dl>
          <div className="border-t border-ink-200 px-4 py-3">
            <Link
              to={withFilters('/close', { propertyId, period: filters.period })}
              className="text-sm text-accent-700 hover:underline"
            >
              Open the close workspace →
            </Link>
          </div>
        </Panel>

        <ChargeGeneration
          propertyId={propertyId}
          period={filters.period}
          className="lg:col-span-3"
        />
      </div>

      <Receivables propertyId={propertyId} period={filters.period} />

      <Panel title="Units" description={`${property.units.totalCount} in this property`}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Unit</th>
              <th>Floor</th>
              <th className="text-right">Area (sq ft)</th>
              <th>Occupancy</th>
              <th>Current lease</th>
            </tr>
          </thead>
          <tbody>
            {property.units.edges.map(({ node }) => (
              <tr key={node.id}>
                <td className="font-medium">{node.identifier}</td>
                <td>{node.floor ?? '—'}</td>
                <td className="tabular text-right">{node.rentableArea?.toLocaleString() ?? '—'}</td>
                <td>
                  <StatusBadge
                    status={node.occupancy}
                    tone={node.occupancy === 'OCCUPIED' ? 'positive' : 'neutral'}
                  />
                </td>
                <td>
                  {node.currentLease ? (
                    <Link
                      to={`/leases/${node.currentLease.id}`}
                      className="text-accent-700 hover:underline"
                    >
                      {node.currentLease.tenant.displayName}
                    </Link>
                  ) : (
                    <span className="text-ink-400">Vacant</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

/**
 * Charge generation.
 *
 * The preview is the contract: confirmation sends back the exact set of
 * generation keys the accountant reviewed, so a lease amended in between causes
 * a conflict rather than silently changing what gets posted.
 */
function ChargeGeneration({
  propertyId,
  period,
  className,
}: {
  propertyId: string;
  period: string;
  className?: string;
}) {
  const { can } = useSession();
  const toast = useToast();
  const [preview, setPreview] = useState<Preview | null>(null);

  const [runPreview, previewState] = useMutation(PREVIEW_CHARGES);
  const [generate, generateState] = useMutation(GENERATE_CHARGES);

  if (!can('charge:generate')) return null;

  return (
    <Panel
      title="Generate charges"
      description={`Proposes charges for ${period}. Nothing is posted until you confirm.`}
      className={className}
      actions={
        <Button
          busy={previewState.loading}
          onClick={async () => {
            const result = await runPreview({
              variables: { input: { propertyId, period } },
            });
            setPreview((result.data?.previewCharges as Preview) ?? null);
          }}
          testId="preview-charges"
        >
          Preview
        </Button>
      }
    >
      {!preview ? (
        <EmptyState
          title="No preview yet"
          description="Preview to see which leases would be billed, at what amounts, and how any partial month was prorated."
        />
      ) : (
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap gap-6 text-sm">
            <span>
              <span className="field-label">Proposed</span>
              <span className="tabular mt-0.5 block font-medium">{preview.proposed.length}</span>
            </span>
            <span>
              <span className="field-label">Already generated</span>
              <span className="tabular mt-0.5 block font-medium">{preview.skippedKeys.length}</span>
            </span>
            <span>
              <span className="field-label">Leases</span>
              <span className="tabular mt-0.5 block font-medium">{preview.leaseCount}</span>
            </span>
            <span>
              <span className="field-label">Total</span>
              <span className="mt-0.5 block">
                <Amount value={preview.totalAmount} emphasis="strong" />
              </span>
            </span>
          </div>

          {preview.warnings.length > 0 && (
            <ul className="space-y-1 rounded border border-caution-600/30 bg-caution-100 p-2 text-xs text-caution-800">
              {preview.warnings.map((warning, index) => (
                <li key={index}>
                  <span className="font-medium">{humanize(warning.code)}:</span> {warning.message}
                </li>
              ))}
            </ul>
          )}

          {preview.proposed.length > 0 && (
            <div className="max-h-72 overflow-y-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Tenant</th>
                    <th>Charge</th>
                    <th>Service period</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.proposed.map((charge) => (
                    <tr key={charge.generationKey}>
                      <td>{charge.tenant.displayName}</td>
                      <td>
                        {charge.description}
                        <span className="block text-xs text-ink-500">{humanize(charge.type)}</span>
                      </td>
                      <td className="text-xs">
                        {formatDate(charge.serviceStart)} – {formatDate(charge.serviceEnd)}
                        {/* Proration is shown, not hidden: a partial month is
                            the most common source of a billing dispute. */}
                        {charge.calculation?.isFullPeriod === false && (
                          <span className="mt-0.5 block text-caution-800">
                            prorated {charge.calculation.occupiedDays}/
                            {charge.calculation.daysInPeriod} days
                          </span>
                        )}
                      </td>
                      <td className="text-right">
                        <Amount value={charge.amount} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview.proposed.length === 0 ? (
            <p className="text-sm text-ink-600">
              Nothing new to generate. Every effective schedule already has a charge for {period}.
            </p>
          ) : (
            <Button
              variant="primary"
              busy={generateState.loading}
              onClick={async () => {
                const result = await generate({
                  variables: {
                    input: {
                      propertyId,
                      period,
                      // Exactly what was on screen. A mismatch is rejected.
                      expectedGenerationKeys: preview.proposed.map(
                        (charge) => charge.generationKey,
                      ),
                      idempotencyKey: crypto.randomUUID(),
                    },
                  },
                  refetchQueries: [
                    { query: PROPERTY_DETAIL, variables: { id: propertyId, period } },
                  ],
                });

                if (!result.errors?.length) {
                  const created = result.data?.generateCharges?.createdCount ?? 0;
                  toast.push({
                    tone: 'success',
                    title: `${created} charge${created === 1 ? '' : 's'} posted`,
                  });
                  setPreview(null);
                }
              }}
              testId="generate-charges"
            >
              Generate {preview.proposed.length} charges ({preview.totalAmount.formatted})
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}

function Receivables({ propertyId, period }: { propertyId: string; period: string }) {
  const { cursor, setCursor } = useFilters({});
  const { data, loading } = useQuery(RECEIVABLES, {
    variables: {
      filter: { propertyIds: [propertyId], period, onlyOutstanding: true },
      first: 25,
      after: cursor,
    },
  });

  const connection = data?.receivables;

  return (
    <Panel
      title="Outstanding receivables"
      description={`Charges in ${period} with an open balance`}
      actions={
        connection && (
          <span className="text-sm">
            <Amount value={connection.totals.outstanding} emphasis="strong" />
          </span>
        )
      }
    >
      {loading && !connection && <LoadingState />}
      {connection && connection.edges.length === 0 && (
        <EmptyState
          title="Nothing outstanding"
          description="Every charge in this period is settled."
        />
      )}

      {connection && connection.edges.length > 0 && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Charge</th>
                <th>Due</th>
                <th className="text-right">Amount</th>
                <th className="text-right">Allocated</th>
                <th className="text-right">Open</th>
                <th className="text-right">Days past due</th>
              </tr>
            </thead>
            <tbody>
              {connection.edges.map(({ node }: { node: ChargeRow }) => (
                <tr key={node.id}>
                  <td>{node.tenant.displayName}</td>
                  <td>{node.description}</td>
                  <td>{formatDate(node.dueDate)}</td>
                  <td className="text-right">
                    <Amount value={node.amount} />
                  </td>
                  <td className="text-right">
                    <Amount value={node.allocatedAmount} showZeroAs="—" />
                  </td>
                  <td className="text-right">
                    <Amount value={node.openBalance} emphasis="strong" />
                  </td>
                  <td className="tabular text-right">
                    {node.daysPastDue > 0 ? (
                      <span
                        className={node.daysPastDue > 30 ? 'text-critical-700' : 'text-caution-800'}
                      >
                        {node.daysPastDue}
                      </span>
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <Pager
            hasNext={connection.pageInfo.hasNextPage}
            hasPrevious={cursor !== null}
            onNext={() => setCursor(connection.pageInfo.endCursor)}
            onReset={() => setCursor(null)}
          />
        </>
      )}
    </Panel>
  );
}

interface PropertyShape {
  id: string;
  code: string;
  name: string;
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  timezone: string;
  unitCount: number;
  activeLeaseCount: number;
  outstandingReceivables: Money;
  unappliedCash: Money;
  period: { id: string; status: string; version: number } | null;
  units: {
    totalCount: number;
    edges: {
      node: {
        id: string;
        identifier: string;
        floor: string | null;
        rentableArea: number | null;
        occupancy: string;
        currentLease: { id: string; tenant: { displayName: string } } | null;
      };
    }[];
  };
}

interface Preview {
  leaseCount: number;
  skippedKeys: string[];
  totalAmount: Money;
  warnings: { code: string; message: string }[];
  proposed: {
    generationKey: string;
    type: string;
    description: string;
    serviceStart: string;
    serviceEnd: string;
    amount: Money;
    tenant: { displayName: string };
    calculation: { isFullPeriod: boolean; occupiedDays: number; daysInPeriod: number } | null;
  }[];
}

interface ChargeRow {
  id: string;
  description: string;
  dueDate: string;
  daysPastDue: number;
  amount: Money;
  allocatedAmount: Money;
  openBalance: Money;
  tenant: { displayName: string };
}
