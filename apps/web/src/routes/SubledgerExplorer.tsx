import { useQuery } from '@apollo/client';
import { ACCOUNT_BALANCES, JOURNAL_ENTRIES, PROPERTIES } from '../graphql/operations';
import { defaultPeriod, useFilters } from '../hooks/useFilters';
import {
  Amount,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Panel,
  formatDate,
  formatInstant,
  humanize,
  type Money,
} from '../components/ui';
import { Pager } from './PortfolioOverview';

/**
 * Subledger explorer.
 *
 * The header figure is the one that matters: debits minus credits over the
 * filtered set must be zero. A non-zero value is a defect, so it is shown
 * prominently rather than buried, and the close checklist blocks on the same
 * condition.
 */
export function SubledgerExplorer() {
  const { filters, setFilters, cursor, setCursor } = useFilters({
    propertyId: '',
    period: defaultPeriod(),
    eventType: '',
    accountCode: '',
  });

  const propertiesQuery = useQuery(PROPERTIES, { variables: { first: 50 } });
  const properties: { id: string; code: string; name: string }[] =
    propertiesQuery.data?.properties.edges.map(
      (edge: { node: { id: string; code: string; name: string } }) => edge.node,
    ) ?? [];

  const propertyId = filters.propertyId || properties[0]?.id || '';

  const entriesQuery = useQuery(JOURNAL_ENTRIES, {
    variables: {
      filter: {
        propertyId,
        period: filters.period || null,
        eventTypes: filters.eventType ? [filters.eventType] : null,
        accountCode: filters.accountCode || null,
      },
      first: 25,
      after: cursor,
    },
    skip: !propertyId,
  });

  const balancesQuery = useQuery(ACCOUNT_BALANCES, {
    variables: { propertyId, period: filters.period },
    skip: !propertyId,
  });

  const connection = entriesQuery.data?.journalEntries;
  const balances = (balancesQuery.data?.accountBalances ?? []) as AccountBalance[];
  const outOfBalance = connection && connection.netDebitMinusCredit.cents !== 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">Subledger</h1>
          <p className="text-sm text-ink-500">
            Posted entries are immutable. A correction is a new, linked entry.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Property">
            <select
              className="input w-56"
              value={propertyId}
              onChange={(event) => setFilters({ propertyId: event.target.value })}
            >
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.code}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Period">
            <input
              type="month"
              className="input w-36"
              value={filters.period}
              onChange={(event) => setFilters({ period: event.target.value })}
            />
          </Field>
          <Field label="Event">
            <select
              className="input w-52"
              value={filters.eventType}
              onChange={(event) => setFilters({ eventType: event.target.value })}
            >
              <option value="">Any event</option>
              {[
                'CHARGE_POSTED',
                'CHARGE_CREDITED',
                'PAYMENT_RECEIVED',
                'PAYMENT_ALLOCATED',
                'ALLOCATION_REVERSED',
                'PAYMENT_REVERSED',
              ].map((value) => (
                <option key={value} value={value}>
                  {humanize(value)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Account">
            <select
              className="input w-52"
              value={filters.accountCode}
              onChange={(event) => setFilters({ accountCode: event.target.value })}
            >
              <option value="">Any account</option>
              {[
                'ACCOUNTS_RECEIVABLE',
                'RENTAL_INCOME',
                'OPERATING_CHARGE_INCOME',
                'CASH_CLEARING',
                'UNAPPLIED_CASH',
              ].map((value) => (
                <option key={value} value={value}>
                  {humanize(value)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      {connection && (
        <div
          className={`rounded-lg border px-4 py-3 ${
            outOfBalance
              ? 'border-critical-600/30 bg-critical-100'
              : 'border-positive-600/30 bg-positive-100'
          }`}
          role={outOfBalance ? 'alert' : undefined}
        >
          <p
            className={`text-sm font-medium ${outOfBalance ? 'text-critical-800' : 'text-positive-800'}`}
          >
            {outOfBalance
              ? 'Debits and credits do not balance over this selection.'
              : 'Debits equal credits over this selection.'}
          </p>
          <p className="mt-0.5 text-xs text-ink-700">
            Net debit minus credit:{' '}
            <Amount value={connection.netDebitMinusCredit} showZeroAs="0.00" />
            {outOfBalance &&
              ' — this indicates a defect. The close checklist blocks on the same condition.'}
          </p>
        </div>
      )}

      <Panel title="Account balances" description={`Period ${filters.period}`}>
        {balancesQuery.loading && balances.length === 0 && <LoadingState />}
        {balances.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Account</th>
                <th className="text-right">Debits</th>
                <th className="text-right">Credits</th>
                <th className="text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((row) => (
                <tr key={row.accountCode}>
                  <td className="font-medium">{humanize(row.accountCode)}</td>
                  <td className="text-right">
                    <Amount value={row.debitTotal} showZeroAs="—" emphasis="muted" />
                  </td>
                  <td className="text-right">
                    <Amount value={row.creditTotal} showZeroAs="—" emphasis="muted" />
                  </td>
                  <td className="text-right">
                    <Amount value={row.balance} emphasis="strong" showZeroAs="—" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="border-t border-ink-200 px-4 py-2 text-xs text-ink-500">
          Income accounts show the period's movement. Receivables, cash clearing and unapplied cash
          show a cumulative balance, because those are positions that carry forward.
        </p>
      </Panel>

      <Panel
        title="Journal entries"
        description={connection ? `${connection.totalCount} in this selection` : undefined}
      >
        {entriesQuery.loading && !connection && <LoadingState />}
        {entriesQuery.error && !connection && (
          <ErrorState
            message={entriesQuery.error.message}
            onRetry={() => void entriesQuery.refetch()}
          />
        )}
        {connection && connection.edges.length === 0 && (
          <EmptyState
            title="No entries match"
            description="Try a different period or event type."
          />
        )}

        {connection && connection.edges.length > 0 && (
          <>
            <div className="divide-y divide-ink-200">
              {connection.edges.map(({ node }: { node: JournalEntry }) => (
                <article key={node.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-ink-900">
                        {humanize(node.eventType)} — {node.description}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        Posted {formatDate(node.postingDate)} · business date{' '}
                        {formatDate(node.businessDate)} · recorded {formatInstant(node.createdAt)}
                      </p>
                      <p className="mt-0.5 font-mono text-2xs text-ink-400">
                        {node.postingEventId}
                        {node.reversesPostingEventId && (
                          <> · reverses {node.reversesPostingEventId}</>
                        )}
                      </p>
                    </div>
                    <div className="text-right text-xs">
                      <p>
                        <span className="text-ink-500">Dr </span>
                        <Amount value={node.totalDebit} />
                      </p>
                      <p>
                        <span className="text-ink-500">Cr </span>
                        <Amount value={node.totalCredit} />
                      </p>
                    </div>
                  </div>

                  <table className="data-table mt-2">
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th>Memo</th>
                        <th className="text-right">Debit</th>
                        <th className="text-right">Credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {node.lines.map((line) => (
                        <tr key={line.id}>
                          <td className="font-medium">{humanize(line.accountCode)}</td>
                          <td className="text-ink-600">{line.memo}</td>
                          <td className="text-right">
                            <Amount value={line.debit} showZeroAs="—" emphasis="muted" />
                          </td>
                          <td className="text-right">
                            <Amount value={line.credit} showZeroAs="—" emphasis="muted" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </article>
              ))}
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
    </div>
  );
}

interface AccountBalance {
  accountCode: string;
  balance: Money;
  debitTotal: Money;
  creditTotal: Money;
}

interface JournalEntry {
  id: string;
  postingEventId: string;
  eventType: string;
  description: string;
  postingDate: string;
  businessDate: string;
  createdAt: string;
  reversesPostingEventId: string | null;
  totalDebit: Money;
  totalCredit: Money;
  lines: { id: string; accountCode: string; memo: string; debit: Money; credit: Money }[];
}
