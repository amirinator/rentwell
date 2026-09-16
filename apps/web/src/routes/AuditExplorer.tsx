import { useQuery } from '@apollo/client';
import { AUDIT_EVENTS } from '../graphql/operations';
import { useFilters } from '../hooks/useFilters';
import {
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Panel,
  formatInstant,
  humanize,
} from '../components/ui';
import { Pager } from './PortfolioOverview';

/**
 * Audit explorer.
 *
 * Records are append-only through the application: nothing here can edit or
 * delete one, and nothing elsewhere in the codebase can either. That is an
 * application-level guarantee rather than a cryptographic one, and the note at
 * the foot of this screen says so rather than implying more.
 */
export function AuditExplorer() {
  const { filters, setFilters, cursor, setCursor } = useFilters({
    entityType: '',
    entityId: '',
    action: '',
  });

  const { data, loading, error, refetch } = useQuery(AUDIT_EVENTS, {
    variables: {
      filter: {
        entityType: filters.entityType || null,
        entityId: filters.entityId || null,
        actions: filters.action ? [filters.action] : null,
      },
      first: 50,
      after: cursor,
    },
  });

  const connection = data?.auditEvents;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-900">Audit history</h1>
        <p className="text-sm text-ink-500">Who did what, when, and with which correlation id.</p>
      </div>

      <Panel
        title="Filters"
        description="Trace one record by pasting its id, or follow one kind of action across the portfolio."
      >
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
          <Field label="Entity type">
            <select
              className="input"
              value={filters.entityType}
              onChange={(event) => setFilters({ entityType: event.target.value })}
            >
              <option value="">Any</option>
              {[
                'BankTransaction',
                'Charge',
                'Allocation',
                'ReconciliationException',
                'AccountingPeriod',
                'ImportBatch',
                'Property',
                'User',
              ].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Entity id">
            <input
              className="input font-mono text-xs"
              value={filters.entityId}
              onChange={(event) => setFilters({ entityId: event.target.value })}
              placeholder="Paste a record id"
            />
          </Field>

          <Field label="Action">
            <select
              className="input"
              value={filters.action}
              onChange={(event) => setFilters({ action: event.target.value })}
            >
              <option value="">Any</option>
              {[
                'CHARGES_GENERATED',
                'ALLOCATIONS_APPROVED',
                'ALLOCATION_REVERSED',
                'PAYMENT_REVERSED',
                'CREDIT_ADJUSTMENT_CREATED',
                'EXCEPTION_RESOLVED',
                'PERIOD_CLOSED',
                'PERIOD_REOPENED',
                'IMPORT_CONFIRMED',
                'IMPORT_FILE_DOWNLOADED',
                'ASSISTANT_RUN_COMPLETED',
                'ASSISTANT_TOOL_DENIED',
                'SIGN_IN_FAILED',
              ].map((value) => (
                <option key={value} value={value}>
                  {humanize(value)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Panel>

      <Panel title="Events" description={connection ? `${connection.totalCount} match` : undefined}>
        {loading && !connection && <LoadingState />}
        {error && !connection && (
          <ErrorState message={error.message} onRetry={() => void refetch()} />
        )}
        {connection && connection.edges.length === 0 && (
          <EmptyState title="No events match" description="Try widening the filters." />
        )}

        {connection && connection.edges.length > 0 && (
          <>
            <div className="max-h-[70vh] overflow-y-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Entity</th>
                    <th>Property</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {connection.edges.map(({ node }: { node: AuditRow }) => (
                    <tr key={node.id}>
                      <td className="whitespace-nowrap text-xs">
                        {formatInstant(node.occurredAt)}
                      </td>
                      <td className="font-medium">{humanize(node.action)}</td>
                      <td className="text-ink-600">
                        {node.actorName ?? (
                          <span className="italic text-ink-500">
                            {node.actorSystem ?? 'system'}
                          </span>
                        )}
                      </td>
                      <td className="text-xs">
                        {node.entityType}
                        <span className="block font-mono text-2xs text-ink-400">
                          {node.entityId.slice(0, 8)}…
                        </span>
                      </td>
                      <td className="text-ink-600">{node.property?.code ?? '—'}</td>
                      <td>
                        <details>
                          <summary className="cursor-pointer text-xs text-accent-700">
                            Metadata
                          </summary>
                          <pre className="mt-1 max-w-md overflow-x-auto rounded bg-ink-50 p-2 text-2xs">
                            {JSON.stringify(node.metadata, null, 2)}
                          </pre>
                          {node.correlationId && (
                            <p className="mt-1 font-mono text-2xs text-ink-400">
                              correlation {node.correlationId}
                            </p>
                          )}
                        </details>
                      </td>
                    </tr>
                  ))}
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

        <p className="border-t border-ink-200 px-4 py-2 text-xs text-ink-500">
          Audit records are append-only through Rentwell's own interfaces: no part of the
          application updates or deletes one. They are not independently tamper-proof — anyone with
          direct database access could still alter this table.
        </p>
      </Panel>
    </div>
  );
}

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorName: string | null;
  actorSystem: string | null;
  metadata: unknown;
  correlationId: string | null;
  occurredAt: string;
  property: { code: string } | null;
}
