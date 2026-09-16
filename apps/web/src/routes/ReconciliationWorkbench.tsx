import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  APPROVE_ALLOCATIONS,
  REGENERATE_SUGGESTIONS,
  REVERSE_ALLOCATION,
  TRANSACTIONS,
  TRANSACTION_WORKBENCH,
} from '../graphql/operations';
import { defaultPeriod, useFilters } from '../hooks/useFilters';
import { useSession } from '../lib/session';
import { useToast } from '../components/Toast';
import {
  Amount,
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Panel,
  StatusBadge,
  formatDate,
  formatInstant,
  humanize,
  type Money,
} from '../components/ui';
import { Pager } from './PortfolioOverview';

/** New idempotency key per attempt, so a retry after a conflict is a new request. */
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function ReconciliationWorkbench() {
  const { transactionId } = useParams<{ transactionId: string }>();

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <PaymentList selectedId={transactionId ?? null} />
      {transactionId ? (
        <PaymentDetail transactionId={transactionId} />
      ) : (
        <Panel title="Select a payment">
          <EmptyState
            title="Nothing selected"
            description="Choose a payment on the left to review its suggested allocations and the evidence behind them."
          />
        </Panel>
      )}
    </div>
  );
}

function PaymentList({ selectedId }: { selectedId: string | null }) {
  const { filters, setFilters, cursor, setCursor } = useFilters({
    period: defaultPeriod(),
    onlyUnreconciled: true,
    search: '',
  });

  const { data, loading, error, refetch } = useQuery(TRANSACTIONS, {
    variables: {
      filter: {
        period: filters.period || null,
        onlyUnreconciled: filters.onlyUnreconciled,
        search: filters.search || null,
      },
      first: 25,
      after: cursor,
    },
  });

  const connection = data?.transactions;

  return (
    <Panel
      title="Payments"
      description={connection ? `${connection.totalCount} match the filter` : undefined}
      actions={
        <div className="flex items-center gap-2">
          <input
            type="month"
            className="input w-36"
            value={filters.period}
            onChange={(event) => setFilters({ period: event.target.value })}
            aria-label="Accounting period"
          />
          <label className="flex items-center gap-1.5 text-xs text-ink-600">
            <input
              type="checkbox"
              checked={filters.onlyUnreconciled}
              onChange={(event) => setFilters({ onlyUnreconciled: event.target.checked })}
            />
            Unreconciled only
          </label>
        </div>
      }
    >
      <div className="border-b border-ink-200 px-4 py-2">
        <input
          type="search"
          className="input"
          placeholder="Search reference, description or external id"
          value={filters.search}
          onChange={(event) => setFilters({ search: event.target.value })}
          aria-label="Search payments"
        />
      </div>

      {connection && (
        <div className="grid grid-cols-3 gap-2 border-b border-ink-200 bg-ink-50 px-4 py-2 text-xs">
          <SummaryCell label="Received" value={connection.totals.received} />
          <SummaryCell label="Allocated" value={connection.totals.allocated} />
          <SummaryCell label="Unapplied" value={connection.totals.unapplied} />
        </div>
      )}

      {loading && !connection && <LoadingState label="Loading payments" />}
      {error && !connection && (
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      )}

      {connection && connection.edges.length === 0 && (
        <EmptyState
          title="No payments match"
          description="Widen the period, or clear the unreconciled filter to include settled payments."
        />
      )}

      {connection && connection.edges.length > 0 && (
        <>
          <div className="max-h-[70vh] overflow-y-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Posted</th>
                  <th>Reference</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Unapplied</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {connection.edges.map(({ node }: { node: TransactionRow }) => (
                  <tr
                    key={node.id}
                    className={node.id === selectedId ? 'bg-accent-100/60' : undefined}
                  >
                    <td className="whitespace-nowrap">
                      <Link
                        to={`/reconciliation/${node.id}`}
                        className="text-accent-700 hover:underline"
                        data-testid={`payment-${node.externalId}`}
                      >
                        {formatDate(node.postedDate)}
                      </Link>
                    </td>
                    <td>
                      <span className="font-medium">{node.reference ?? '—'}</span>
                      {node.description && (
                        <span className="mt-0.5 block max-w-xs truncate text-xs text-ink-500">
                          {node.description}
                        </span>
                      )}
                    </td>
                    <td className="text-right">
                      <Amount value={node.amount} />
                    </td>
                    <td className="text-right">
                      <Amount value={node.unappliedAmount} showZeroAs="—" />
                    </td>
                    <td>
                      <StatusBadge status={node.status} />
                      {node.exception && (
                        <span className="mt-1 block">
                          <StatusBadge status={node.exception.severity} />
                        </span>
                      )}
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
    </Panel>
  );
}

function SummaryCell({ label, value }: { label: string; value: Money }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-0.5">
        <Amount value={value} emphasis="strong" />
      </p>
    </div>
  );
}

function PaymentDetail({ transactionId }: { transactionId: string }) {
  const { can } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [selectedSuggestion, setSelectedSuggestion] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const { data, loading, error, refetch } = useQuery(TRANSACTION_WORKBENCH, {
    variables: { id: transactionId },
    fetchPolicy: 'cache-and-network',
  });

  const [approve, approveState] = useMutation(APPROVE_ALLOCATIONS);
  const [reverse, reverseState] = useMutation(REVERSE_ALLOCATION);
  const [regenerate, regenerateState] = useMutation(REGENERATE_SUGGESTIONS);

  const transaction = data?.transaction as TransactionDetail | undefined;

  const suggestions = useMemo(
    () => [...(transaction?.suggestions ?? [])].sort((a, b) => b.score - a.score),
    [transaction],
  );

  if (loading && !transaction) {
    return (
      <Panel>
        <LoadingState label="Loading payment" />
      </Panel>
    );
  }
  if (error && !transaction) {
    return (
      <Panel>
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      </Panel>
    );
  }
  if (!transaction) {
    return (
      <Panel>
        <EmptyState title="Payment not found" />
      </Panel>
    );
  }

  const onApprove = async (suggestion: Suggestion) => {
    if (suggestion.isStale) {
      toast.push({
        tone: 'warning',
        title: 'This proposal is out of date',
        detail: 'The payment or one of its charges changed. Regenerate before approving.',
        ttl: null,
      });
      return;
    }

    const result = await approve({
      variables: {
        input: {
          transactionId: transaction.id,
          suggestionId: suggestion.id,
          // The versions the reviewer actually saw. A mismatch is a conflict,
          // not a silent overwrite.
          expectedTransactionVersion: transaction.version,
          expectedChargeVersions: suggestion.lines.map((line) => ({
            chargeId: line.charge.id,
            version: line.charge.version,
          })),
          note: note.trim() || null,
          idempotencyKey: newIdempotencyKey(),
        },
      },
      // Balances moved; nothing cached about this payment is trustworthy.
      refetchQueries: [{ query: TRANSACTION_WORKBENCH, variables: { id: transaction.id } }],
      awaitRefetchQueries: true,
    });

    if (result.errors?.length) return; // The error link has already reported it.

    const payload = result.data?.approveAllocations;
    toast.push({
      tone: 'success',
      title: 'Allocations approved',
      detail: `${payload?.totalAllocated?.formatted ?? ''} applied. ${
        payload?.remainingUnapplied?.cents
          ? 'A remainder is still unapplied.'
          : 'Nothing left over.'
      }`,
    });
    setNote('');
    setSelectedSuggestion(null);
  };

  const onReverse = async (allocationId: string) => {
    const reason = window.prompt('Why is this allocation being reversed?');
    if (!reason || reason.trim().length < 4) return;

    const result = await reverse({
      variables: {
        input: { allocationId, reason: reason.trim(), idempotencyKey: newIdempotencyKey() },
      },
      refetchQueries: [{ query: TRANSACTION_WORKBENCH, variables: { id: transaction.id } }],
      awaitRefetchQueries: true,
    });

    if (!result.errors?.length) {
      toast.push({ tone: 'success', title: 'Allocation reversed' });
    }
  };

  return (
    <div className="space-y-4">
      <Panel
        title={`Payment ${transaction.externalId}`}
        description={`${transaction.property.code} · ${transaction.bankAccount.label} (…${transaction.bankAccount.maskedNumber})`}
        actions={
          <>
            <StatusBadge status={transaction.status} />
            {can('suggestion:regenerate') && (
              <Button
                busy={regenerateState.loading}
                onClick={async () => {
                  await regenerate({
                    variables: { input: { transactionId: transaction.id } },
                    refetchQueries: [
                      { query: TRANSACTION_WORKBENCH, variables: { id: transaction.id } },
                    ],
                    awaitRefetchQueries: true,
                  });
                }}
              >
                Regenerate suggestions
              </Button>
            )}
          </>
        }
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 text-sm md:grid-cols-4">
          <Detail label="Amount">
            <Amount value={transaction.amount} emphasis="strong" />
          </Detail>
          <Detail label="Allocated">
            <Amount value={transaction.allocatedAmount} showZeroAs="—" />
          </Detail>
          <Detail label="Unapplied">
            <Amount value={transaction.unappliedAmount} showZeroAs="—" />
          </Detail>
          <Detail label="Posted">{formatDate(transaction.postedDate)}</Detail>
          <Detail label="Reference">{transaction.reference ?? '—'}</Detail>
          <Detail label="Period">{transaction.period}</Detail>
          <Detail label="Source">{humanize(transaction.source)}</Detail>
          <Detail label="Record version">{transaction.version}</Detail>
        </dl>

        {transaction.description && (
          <div className="border-t border-ink-200 px-4 py-3">
            <p className="field-label">Description supplied by the payer</p>
            <p className="mt-1 rounded bg-ink-50 px-2 py-1.5 font-mono text-xs text-ink-700">
              {transaction.description}
            </p>
            {/* Stated plainly: this text comes from whoever sent the money. */}
            <p className="mt-1 text-2xs text-ink-500">
              This text is written by the payer and is not verified by Rentwell.
            </p>
          </div>
        )}

        {transaction.exception && (
          <div className="border-t border-ink-200 px-4 py-3">
            <Link
              to={`/exceptions/${transaction.exception.id}`}
              className="text-sm text-accent-700 hover:underline"
            >
              Open exception: {humanize(transaction.exception.category)} →
            </Link>
          </div>
        )}
      </Panel>

      {transaction.allocations.length > 0 && (
        <Panel title="Allocations" description="Active and reversed, in order of approval">
          <table className="data-table">
            <thead>
              <tr>
                <th>Charge</th>
                <th className="text-right">Amount</th>
                <th>Approved by</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {transaction.allocations.map((allocation) => (
                <tr key={allocation.id}>
                  <td>
                    {allocation.charge.description}
                    <span className="block text-xs text-ink-500">
                      due {formatDate(allocation.charge.dueDate)}
                    </span>
                  </td>
                  <td className="text-right">
                    <Amount value={allocation.amount} />
                  </td>
                  <td className="text-ink-600">{allocation.approvedBy?.displayName ?? 'System'}</td>
                  <td>
                    <StatusBadge status={allocation.status} />
                    {allocation.reversal && (
                      <span className="mt-1 block text-2xs text-ink-500">
                        {allocation.reversal.reason}
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    {allocation.status === 'ACTIVE' && can('allocation:reverse') && (
                      <Button
                        variant="danger"
                        busy={reverseState.loading}
                        onClick={() => void onReverse(allocation.id)}
                      >
                        Reverse
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel
        title="Suggested allocations"
        description="A ranking score orders these for review. It is not a probability that the match is correct."
      >
        {suggestions.length === 0 ? (
          <EmptyState
            title="No suggestions"
            description="No tenant could be identified from the reference or description, or no open charge matched. Allocate manually from the exception workspace."
          />
        ) : (
          <ul className="divide-y divide-ink-200">
            {suggestions.map((suggestion) => (
              <li key={suggestion.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-ink-900">
                      {humanize(suggestion.strategy)}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      Ranking score {suggestion.score} of 100 · rule {suggestion.ruleVersion} ·
                      generated {formatInstant(suggestion.generatedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {suggestion.isStale && <StatusBadge status="SUPERSEDED" tone="caution" />}
                    <StatusBadge status={suggestion.status} />
                  </div>
                </div>

                {suggestion.isStale && (
                  <p className="mt-2 rounded border border-caution-600/30 bg-caution-100 px-2 py-1.5 text-xs text-caution-800">
                    The payment or one of these charges changed after this proposal was computed.
                    Regenerate before approving.
                  </p>
                )}

                <table className="data-table mt-3">
                  <thead>
                    <tr>
                      <th>Charge</th>
                      <th>Due</th>
                      <th className="text-right">Open balance</th>
                      <th className="text-right">Proposed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggestion.lines.map((line) => (
                      <tr key={line.charge.id}>
                        <td>
                          {line.charge.description}
                          <span className="block text-xs text-ink-500">
                            {line.charge.tenant.displayName}
                          </span>
                        </td>
                        <td>{formatDate(line.charge.dueDate)}</td>
                        <td className="text-right">
                          <Amount value={line.charge.openBalance} />
                        </td>
                        <td className="text-right">
                          <Amount value={line.amount} emphasis="strong" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-medium text-accent-700">
                    Why this was suggested ({suggestion.evidence.length} pieces of evidence)
                  </summary>
                  <ul className="mt-2 space-y-1.5">
                    {suggestion.evidence.map((item, index) => (
                      <li key={index} className="flex gap-2 text-xs text-ink-700">
                        <span className="tabular w-10 shrink-0 text-right font-medium text-ink-500">
                          +{item.contribution}
                        </span>
                        <span>{item.label}</span>
                      </li>
                    ))}
                  </ul>
                  <dl className="mt-3 grid grid-cols-5 gap-2 rounded bg-ink-50 p-2 text-2xs">
                    {(
                      [
                        ['Reference', suggestion.scoreComponents.referencePoints],
                        ['Amount', suggestion.scoreComponents.amountPoints],
                        ['Date', suggestion.scoreComponents.datePoints],
                        ['Description', suggestion.scoreComponents.descriptionPoints],
                        ['Total', suggestion.scoreComponents.totalPoints],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-ink-500">{label}</dt>
                        <dd className="tabular font-semibold">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>

                {suggestion.warnings.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {suggestion.warnings.map((warning) => (
                      <li key={warning} className="text-xs text-caution-800">
                        ! {humanize(warning)}
                      </li>
                    ))}
                  </ul>
                )}

                {suggestion.status === 'PROPOSED' && can('allocation:approve') && (
                  <div className="mt-4 space-y-2 border-t border-ink-200 pt-3">
                    {selectedSuggestion === suggestion.id ? (
                      <>
                        {/* A confirmation that restates the amounts and the
                            records affected, before anything is committed. */}
                        <div className="rounded border border-accent-200 bg-accent-50 p-3 text-sm">
                          <p className="font-medium text-ink-900">Confirm this allocation</p>
                          <p className="mt-1 text-ink-700">
                            Apply <Amount value={suggestion.totalAmount} emphasis="strong" /> from
                            payment {transaction.externalId} across {suggestion.lines.length} charge
                            {suggestion.lines.length === 1 ? '' : 's'}.
                            {suggestion.remainder.cents > 0 && (
                              <>
                                {' '}
                                <Amount value={suggestion.remainder} /> will remain as unapplied
                                cash.
                              </>
                            )}
                          </p>
                        </div>

                        <Field label="Note (optional)">
                          <input
                            className="input"
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            placeholder="Anything a reviewer should know"
                          />
                        </Field>

                        <div className="flex gap-2">
                          <Button
                            variant="primary"
                            busy={approveState.loading}
                            onClick={() => void onApprove(suggestion)}
                            testId="confirm-approve"
                          >
                            Approve allocation
                          </Button>
                          <Button onClick={() => setSelectedSuggestion(null)}>Cancel</Button>
                        </div>
                      </>
                    ) : (
                      <Button
                        variant="primary"
                        disabled={suggestion.isStale}
                        onClick={() => setSelectedSuggestion(suggestion.id)}
                        testId={`approve-${suggestion.strategy}`}
                      >
                        Review and approve
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="flex justify-end">
        <Button onClick={() => navigate('/reconciliation')}>Back to the list</Button>
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="field-label">{label}</dt>
      <dd className="mt-0.5 text-ink-900">{children}</dd>
    </div>
  );
}

// --------------------------------------------------------------------------
// Response shapes
// --------------------------------------------------------------------------

interface TransactionRow {
  id: string;
  externalId: string;
  status: string;
  postedDate: string;
  reference: string | null;
  description: string | null;
  amount: Money;
  unappliedAmount: Money;
  exception: { id: string; category: string; severity: string } | null;
}

interface SuggestionLine {
  amount: Money;
  charge: {
    id: string;
    description: string;
    dueDate: string;
    version: number;
    openBalance: Money;
    tenant: { displayName: string };
  };
}

interface Suggestion {
  id: string;
  strategy: string;
  status: string;
  score: number;
  ruleVersion: string;
  isStale: boolean;
  warnings: string[];
  generatedAt: string;
  totalAmount: Money;
  remainder: Money;
  scoreComponents: {
    referencePoints: number;
    amountPoints: number;
    datePoints: number;
    descriptionPoints: number;
    totalPoints: number;
  };
  evidence: { kind: string; label: string; contribution: number }[];
  lines: SuggestionLine[];
}

interface TransactionDetail {
  id: string;
  externalId: string;
  source: string;
  status: string;
  version: number;
  period: string;
  postedDate: string;
  reference: string | null;
  description: string | null;
  amount: Money;
  allocatedAmount: Money;
  unappliedAmount: Money;
  property: { id: string; code: string; name: string };
  bankAccount: { label: string; maskedNumber: string };
  allocations: {
    id: string;
    status: string;
    amount: Money;
    charge: { id: string; description: string; dueDate: string };
    approvedBy: { displayName: string } | null;
    reversal: { reason: string } | null;
  }[];
  suggestions: Suggestion[];
  exception: { id: string; category: string; severity: string } | null;
}
