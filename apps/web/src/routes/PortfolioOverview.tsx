import { useState } from 'react';
import { useQuery } from '@apollo/client';
import { Link } from 'react-router-dom';
import { PORTFOLIO_SUMMARY, PROPERTIES } from '../graphql/operations';
import { defaultPeriod, useFilters, withFilters } from '../hooks/useFilters';
import {
  Amount,
  EmptyState,
  ErrorState,
  LoadingState,
  Metric,
  Panel,
  StaleBanner,
  StatusBadge,
  formatDate,
  type Money,
} from '../components/ui';

/**
 * Portfolio overview.
 *
 * Every figure here links to the records behind it, carrying the same period
 * and property filter into the next screen, so a total and the list it opens
 * cannot disagree about what they cover.
 *
 * The metric notes at the bottom are not decoration: each headline number
 * states which date field the period was applied to and how reversals were
 * treated, which is what makes the figure defensible in a review.
 */
export function PortfolioOverview({ initialTab }: { initialTab?: 'summary' | 'properties' } = {}) {
  const { filters, setFilters } = useFilters({ period: defaultPeriod(), search: '' });
  const [tab, setTab] = useState<'summary' | 'properties'>(initialTab ?? 'summary');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">Portfolio overview</h1>
          <p className="text-sm text-ink-500">
            Receivables, cash and close status across the portfolio.
          </p>
        </div>

        <div className="flex items-end gap-3">
          <label className="block">
            <span className="field-label">Accounting period</span>
            <input
              type="month"
              className="input mt-1 w-40"
              value={filters.period}
              onChange={(event) => setFilters({ period: event.target.value })}
              data-testid="period-filter"
            />
          </label>

          <div className="flex rounded-md border border-ink-300 p-0.5">
            {(['summary', 'properties'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={`rounded px-3 py-1 text-sm capitalize ${
                  tab === value ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100'
                }`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tab === 'summary' ? <SummaryTab period={filters.period} /> : <PropertiesTab />}
    </div>
  );
}

function SummaryTab({ period }: { period: string }) {
  const { data, loading, error, networkStatus, refetch } = useQuery(PORTFOLIO_SUMMARY, {
    variables: { filter: { period } },
    notifyOnNetworkStatusChange: true,
  });

  const summary = data?.portfolioSummary;

  if (loading && !summary)
    return (
      <Panel>
        <LoadingState label="Loading portfolio totals" />
      </Panel>
    );

  if (error && !summary) {
    return (
      <Panel>
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      </Panel>
    );
  }

  if (!summary) {
    return (
      <Panel>
        <EmptyState
          title="No data for this period"
          description="Generate charges for a property to see totals here."
        />
      </Panel>
    );
  }

  const linkParams = { period };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-500">Aged as of {formatDate(summary.asOfDate)}</p>
        <StaleBanner refreshedAt={summary.refreshedAt} isRefreshing={networkStatus === 4} />
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric
          label="Charges posted"
          value={<Amount value={summary.chargesPosted} emphasis="strong" />}
          to={withFilters('/reconciliation', linkParams)}
        />
        <Metric
          label="Payments received"
          value={<Amount value={summary.paymentsReceived} emphasis="strong" />}
          to={withFilters('/reconciliation', linkParams)}
        />
        <Metric
          label="Allocated"
          value={<Amount value={summary.paymentsAllocated} emphasis="strong" />}
          hint={`${(summary.allocationRate * 100).toFixed(1)}% of receipts`}
        />
        <Metric
          label="Unapplied cash"
          value={<Amount value={summary.unappliedCash} emphasis="strong" />}
          hint="Received but not matched to a charge"
          to={withFilters('/reconciliation', { ...linkParams, onlyUnreconciled: 'true' })}
        />
        <Metric
          label="Outstanding receivables"
          value={<Amount value={summary.outstandingReceivables} emphasis="strong" />}
          hint="Cumulative, not this period alone"
        />
      </dl>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel
          title="Receivables aging"
          description={`As of ${formatDate(summary.asOfDate)}`}
          className="lg:col-span-2"
        >
          <table className="data-table">
            <thead>
              <tr>
                <th>Bucket</th>
                <th className="text-right">Charges</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {summary.aging.map(
                (bucket: { label: string; chargeCount: number; amount: Money }) => (
                  <tr key={bucket.label}>
                    <td>{bucket.label}</td>
                    <td className="tabular text-right">{bucket.chargeCount}</td>
                    <td className="text-right">
                      <Amount value={bucket.amount} showZeroAs="—" />
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </Panel>

        <Panel title="Processing" description="Background work and delivery health">
          <dl className="divide-y divide-ink-100">
            <ProcessingRow
              label="Imports in progress"
              value={summary.processing.importsInProgress}
            />
            <ProcessingRow
              label="Failed imports"
              value={summary.processing.failedImports}
              tone={summary.processing.failedImports > 0 ? 'critical' : 'neutral'}
            />
            <ProcessingRow
              label="Undispatched events"
              value={summary.processing.pendingOutboxEvents}
              tone={summary.processing.pendingOutboxEvents > 50 ? 'caution' : 'neutral'}
            />
            <ProcessingRow
              label="Oldest pending event"
              value={`${summary.processing.oldestPendingEventAgeSeconds}s`}
              tone={summary.processing.oldestPendingEventAgeSeconds > 60 ? 'caution' : 'neutral'}
            />
            <ProcessingRow
              label="Dead-letter events"
              value={summary.processing.deadLetterEvents}
              tone={summary.processing.deadLetterEvents > 0 ? 'critical' : 'neutral'}
            />
          </dl>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Exceptions by severity">
          {summary.exceptionsBySeverity.length === 0 ? (
            <EmptyState
              title="No open exceptions"
              description="Everything received has been reconciled."
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th className="text-right">Count</th>
                  <th className="text-right">Unreconciled</th>
                </tr>
              </thead>
              <tbody>
                {summary.exceptionsBySeverity.map(
                  (bucket: { key: string; count: number; amount: Money }) => (
                    <tr key={bucket.key}>
                      <td>
                        <Link
                          to={withFilters('/exceptions', { severities: bucket.key, period })}
                          className="text-accent-700 hover:underline"
                        >
                          <StatusBadge status={bucket.key} />
                        </Link>
                      </td>
                      <td className="tabular text-right">{bucket.count}</td>
                      <td className="text-right">
                        <Amount value={bucket.amount} showZeroAs="—" />
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Close status" description={`Period ${period}`}>
          {summary.closeStatus.length === 0 ? (
            <EmptyState title="No periods opened yet" />
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>Status</th>
                    <th className="text-right">Blockers</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.closeStatus.map(
                    (row: {
                      status: string;
                      blockerCount: number;
                      property: { id: string; code: string; name: string };
                    }) => (
                      <tr key={row.property.id}>
                        <td>
                          <Link
                            to={withFilters('/close', { propertyId: row.property.id, period })}
                            className="text-accent-700 hover:underline"
                          >
                            {row.property.code}
                          </Link>
                          <span className="ml-2 text-ink-500">{row.property.name}</span>
                        </td>
                        <td>
                          <StatusBadge status={row.status} />
                        </td>
                        <td className="tabular text-right">
                          {row.blockerCount > 0 ? (
                            <span className="text-critical-700">{row.blockerCount}</span>
                          ) : (
                            <span className="text-ink-400">—</span>
                          )}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="How these figures are calculated"
        description="Each metric states the date field its period filter is applied to and how reversed records are treated."
      >
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Date basis</th>
                <th>Reversals and credits</th>
                <th>Filters</th>
              </tr>
            </thead>
            <tbody>
              {summary.metricNotes.map(
                (note: {
                  metric: string;
                  dateBasis: string;
                  reversalTreatment: string;
                  filters: string;
                }) => (
                  <tr key={note.metric}>
                    <td className="font-medium">{note.metric}</td>
                    <td className="text-ink-600">{note.dateBasis}</td>
                    <td className="text-ink-600">{note.reversalTreatment}</td>
                    <td className="text-ink-600">{note.filters}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function ProcessingRow({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number | string;
  tone?: 'neutral' | 'caution' | 'critical';
}) {
  const colour =
    tone === 'critical'
      ? 'text-critical-700'
      : tone === 'caution'
        ? 'text-caution-800'
        : 'text-ink-900';

  return (
    <div className="flex items-center justify-between px-4 py-2 text-sm">
      <dt className="text-ink-600">{label}</dt>
      <dd className={`tabular font-medium ${colour}`}>{value}</dd>
    </div>
  );
}

function PropertiesTab() {
  const { filters, setFilters, cursor, setCursor } = useFilters({ search: '' });

  const { data, loading, error, refetch } = useQuery(PROPERTIES, {
    variables: { first: 25, after: cursor, search: filters.search || null },
  });

  const connection = data?.properties;

  return (
    <Panel
      title="Properties"
      description={connection ? `${connection.totalCount} in scope` : undefined}
      actions={
        <input
          type="search"
          className="input w-56"
          placeholder="Search code, name or city"
          value={filters.search}
          onChange={(event) => setFilters({ search: event.target.value })}
          aria-label="Search properties"
        />
      }
    >
      {loading && !connection && <LoadingState label="Loading properties" />}
      {error && !connection && (
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      )}

      {connection && connection.edges.length === 0 && (
        <EmptyState
          title="No properties match"
          description={
            filters.search
              ? 'Try a different search term.'
              : 'You are not assigned to any properties yet. An administrator can assign them.'
          }
        />
      )}

      {connection && connection.edges.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Location</th>
                  <th className="text-right">Units</th>
                  <th className="text-right">Active leases</th>
                  <th className="text-right">Outstanding</th>
                  <th className="text-right">Unapplied cash</th>
                  <th className="text-right">Exceptions</th>
                </tr>
              </thead>
              <tbody>
                {connection.edges.map(
                  ({
                    node,
                  }: {
                    node: {
                      id: string;
                      code: string;
                      name: string;
                      city: string;
                      region: string;
                      unitCount: number;
                      activeLeaseCount: number;
                      openExceptionCount: number;
                      outstandingReceivables: Money;
                      unappliedCash: Money;
                    };
                  }) => (
                    <tr key={node.id}>
                      <td>
                        <Link
                          to={`/properties/${node.id}`}
                          className="font-medium text-accent-700 hover:underline"
                        >
                          {node.code}
                        </Link>
                      </td>
                      <td>{node.name}</td>
                      <td className="text-ink-600">
                        {node.city}, {node.region}
                      </td>
                      <td className="tabular text-right">{node.unitCount}</td>
                      <td className="tabular text-right">{node.activeLeaseCount}</td>
                      <td className="text-right">
                        <Amount value={node.outstandingReceivables} showZeroAs="—" />
                      </td>
                      <td className="text-right">
                        <Amount value={node.unappliedCash} showZeroAs="—" />
                      </td>
                      <td className="tabular text-right">
                        {node.openExceptionCount > 0 ? (
                          <Link
                            to={withFilters('/exceptions', { propertyIds: node.id })}
                            className="text-critical-700 hover:underline"
                          >
                            {node.openExceptionCount}
                          </Link>
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>

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

export function Pager({
  hasNext,
  hasPrevious,
  onNext,
  onReset,
}: {
  hasNext: boolean;
  hasPrevious: boolean;
  onNext: () => void;
  onReset: () => void;
}) {
  if (!hasNext && !hasPrevious) return null;

  return (
    <div className="flex items-center justify-end gap-2 border-t border-ink-200 px-4 py-2">
      {hasPrevious && (
        <button type="button" onClick={onReset} className="text-sm text-ink-600 hover:underline">
          Back to first page
        </button>
      )}
      {hasNext && (
        <button
          type="button"
          onClick={onNext}
          className="rounded border border-ink-300 px-2.5 py-1 text-sm hover:bg-ink-50"
        >
          Next page
        </button>
      )}
    </div>
  );
}
