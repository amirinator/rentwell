import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { Link, useParams } from 'react-router-dom';
import {
  ANALYZE_EXCEPTION,
  COMMENT_ON_EXCEPTION,
  EXCEPTIONS,
  EXCEPTION_DETAIL,
  RESOLVE_EXCEPTION,
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

const RESOLUTIONS = [
  { value: 'ALLOCATED', label: 'Allocated to the correct charges', needsAction: true },
  { value: 'REVERSED', label: 'Payment reversed', needsAction: true },
  { value: 'CREDIT_ISSUED', label: 'Credit issued against the charge', needsAction: true },
  {
    value: 'CLASSIFIED_UNAPPLIED',
    label: 'Classified as unapplied cash (controller)',
    needsAction: false,
  },
  { value: 'DUPLICATE_CONFIRMED', label: 'Confirmed duplicate', needsAction: false },
  { value: 'WRITTEN_OFF', label: 'Written off (controller)', needsAction: false },
  { value: 'NO_ACTION_REQUIRED', label: 'No action required', needsAction: false },
] as const;

export function ExceptionWorkspace() {
  const { exceptionId } = useParams<{ exceptionId: string }>();

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      <ExceptionList selectedId={exceptionId ?? null} />
      {exceptionId ? (
        <ExceptionDetail exceptionId={exceptionId} />
      ) : (
        <Panel title="Select an exception">
          <EmptyState
            title="Nothing selected"
            description="Choose an exception to see the payment, the candidate charges and the history behind it."
          />
        </Panel>
      )}
    </div>
  );
}

function ExceptionList({ selectedId }: { selectedId: string | null }) {
  const { filters, setFilters, cursor, setCursor } = useFilters({
    period: defaultPeriod(),
    statuses: [] as string[],
    severities: [] as string[],
    onlyBlocking: false,
  });

  const { data, loading, error, refetch } = useQuery(EXCEPTIONS, {
    variables: {
      filter: {
        period: filters.period || null,
        statuses: filters.statuses.length > 0 ? filters.statuses : null,
        severities: filters.severities.length > 0 ? filters.severities : null,
        onlyBlocking: filters.onlyBlocking,
      },
      first: 25,
      after: cursor,
    },
  });

  const connection = data?.exceptions;

  return (
    <Panel
      title="Exceptions"
      description={connection ? `${connection.totalCount} match the filter` : undefined}
      actions={
        <label className="flex items-center gap-1.5 text-xs text-ink-600">
          <input
            type="checkbox"
            checked={filters.onlyBlocking}
            onChange={(event) => setFilters({ onlyBlocking: event.target.checked })}
          />
          Blocks close only
        </label>
      }
    >
      <div className="flex flex-wrap gap-3 border-b border-ink-200 px-4 py-2">
        <input
          type="month"
          className="input w-36"
          value={filters.period}
          onChange={(event) => setFilters({ period: event.target.value })}
          aria-label="Accounting period"
        />
        <select
          className="input w-40"
          value={filters.statuses[0] ?? ''}
          onChange={(event) =>
            setFilters({ statuses: event.target.value ? [event.target.value] : [] })
          }
          aria-label="Status"
        >
          <option value="">Any status</option>
          {['OPEN', 'ASSIGNED', 'IN_REVIEW', 'RESOLVED'].map((status) => (
            <option key={status} value={status}>
              {humanize(status)}
            </option>
          ))}
        </select>
        <select
          className="input w-36"
          value={filters.severities[0] ?? ''}
          onChange={(event) =>
            setFilters({ severities: event.target.value ? [event.target.value] : [] })
          }
          aria-label="Severity"
        >
          <option value="">Any severity</option>
          {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((severity) => (
            <option key={severity} value={severity}>
              {humanize(severity)}
            </option>
          ))}
        </select>
      </div>

      {loading && !connection && <LoadingState label="Loading exceptions" />}
      {error && !connection && (
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      )}

      {connection && connection.edges.length === 0 && (
        <EmptyState title="No exceptions match" description="Nothing needs investigating here." />
      )}

      {connection && connection.edges.length > 0 && (
        <>
          <div className="max-h-[70vh] overflow-y-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Severity</th>
                  <th className="text-right">Unreconciled</th>
                  <th>Owner</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {connection.edges.map(({ node }: { node: ExceptionRow }) => (
                  <tr
                    key={node.id}
                    className={node.id === selectedId ? 'bg-accent-100/60' : undefined}
                  >
                    <td>
                      <Link
                        to={`/exceptions/${node.id}`}
                        className="font-medium text-accent-700 hover:underline"
                      >
                        {humanize(node.category)}
                      </Link>
                      {node.isBlocking && (
                        <span className="ml-2 text-2xs font-medium text-critical-700">
                          blocks close
                        </span>
                      )}
                      <span className="mt-0.5 block max-w-md truncate text-xs text-ink-500">
                        {node.summary}
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={node.severity} />
                    </td>
                    <td className="text-right">
                      <Amount value={node.openAmount} showZeroAs="—" />
                    </td>
                    <td className="text-ink-600">{node.assignedTo?.displayName ?? 'Unassigned'}</td>
                    <td>
                      <StatusBadge status={node.status} />
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

function ExceptionDetail({ exceptionId }: { exceptionId: string }) {
  const { can } = useSession();
  const toast = useToast();
  const [resolution, setResolution] = useState<string>('');
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');

  const { data, loading, error, refetch } = useQuery(EXCEPTION_DETAIL, {
    variables: { id: exceptionId },
    fetchPolicy: 'cache-and-network',
  });

  const [resolve, resolveState] = useMutation(RESOLVE_EXCEPTION);
  const [analyze, analyzeState] = useMutation(ANALYZE_EXCEPTION);
  const [addComment, commentState] = useMutation(COMMENT_ON_EXCEPTION);

  const exception = data?.exception as ExceptionDetailShape | undefined;

  if (loading && !exception)
    return (
      <Panel>
        <LoadingState label="Loading exception" />
      </Panel>
    );
  if (error && !exception) {
    return (
      <Panel>
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      </Panel>
    );
  }
  if (!exception)
    return (
      <Panel>
        <EmptyState title="Exception not found" />
      </Panel>
    );

  const latestRun = exception.assistantRuns[0];

  const onResolve = async () => {
    const result = await resolve({
      variables: {
        input: {
          exceptionId: exception.id,
          resolution,
          reason: reason.trim(),
          expectedVersion: exception.version,
        },
      },
      refetchQueries: [{ query: EXCEPTION_DETAIL, variables: { id: exception.id } }],
      awaitRefetchQueries: true,
    });

    if (!result.errors?.length) {
      toast.push({ tone: 'success', title: 'Exception resolved' });
      setResolution('');
      setReason('');
    }
  };

  return (
    <div className="space-y-4">
      <Panel
        title={humanize(exception.category)}
        description={exception.summary}
        actions={
          <>
            <StatusBadge status={exception.severity} />
            <StatusBadge status={exception.status} />
          </>
        }
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 text-sm md:grid-cols-4">
          <div>
            <dt className="field-label">Unreconciled</dt>
            <dd className="mt-0.5">
              <Amount value={exception.openAmount} emphasis="strong" showZeroAs="—" />
            </dd>
          </div>
          <div>
            <dt className="field-label">Period</dt>
            <dd className="mt-0.5">{exception.period}</dd>
          </div>
          <div>
            <dt className="field-label">Property</dt>
            <dd className="mt-0.5">{exception.property.code}</dd>
          </div>
          <div>
            <dt className="field-label">Opened</dt>
            <dd className="mt-0.5">{formatInstant(exception.createdAt)}</dd>
          </div>
        </dl>

        {exception.resolution && (
          <div className="border-t border-ink-200 bg-positive-100/50 px-4 py-3 text-sm">
            <p className="font-medium text-positive-800">
              Resolved as {humanize(exception.resolution)}
            </p>
            <p className="mt-0.5 text-ink-700">{exception.resolutionReason}</p>
          </div>
        )}
      </Panel>

      {exception.transaction && (
        <Panel title="Source payment">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 text-sm md:grid-cols-4">
            <div>
              <dt className="field-label">Amount</dt>
              <dd className="mt-0.5">
                <Amount value={exception.transaction.amount} emphasis="strong" />
              </dd>
            </div>
            <div>
              <dt className="field-label">Unapplied</dt>
              <dd className="mt-0.5">
                <Amount value={exception.transaction.unappliedAmount} showZeroAs="—" />
              </dd>
            </div>
            <div>
              <dt className="field-label">Posted</dt>
              <dd className="mt-0.5">{formatDate(exception.transaction.postedDate)}</dd>
            </div>
            <div>
              <dt className="field-label">Reference</dt>
              <dd className="mt-0.5">{exception.transaction.reference ?? '—'}</dd>
            </div>
          </dl>

          {exception.transaction.description && (
            <div className="border-t border-ink-200 px-4 py-3">
              <p className="field-label">Payer-supplied description (not verified)</p>
              <p className="mt-1 rounded bg-ink-50 px-2 py-1.5 font-mono text-xs">
                {exception.transaction.description}
              </p>
            </div>
          )}

          <div className="border-t border-ink-200 px-4 py-3">
            <Link
              to={`/reconciliation/${exception.transaction.id}`}
              className="text-sm text-accent-700 hover:underline"
            >
              Open in the reconciliation workbench →
            </Link>
          </div>
        </Panel>
      )}

      {exception.candidateCharges.length > 0 && (
        <Panel title="Candidate charges" description="Open charges this payment could settle">
          <table className="data-table">
            <thead>
              <tr>
                <th>Charge</th>
                <th>Tenant</th>
                <th>Due</th>
                <th className="text-right">Open balance</th>
              </tr>
            </thead>
            <tbody>
              {exception.candidateCharges.map((charge) => (
                <tr key={charge.id}>
                  <td>{charge.description}</td>
                  <td className="text-ink-600">{charge.tenant.displayName}</td>
                  <td>{formatDate(charge.dueDate)}</td>
                  <td className="text-right">
                    <Amount value={charge.openBalance} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel
        title="AI investigation"
        description="Read-only. The assistant retrieves records you can already see; it cannot approve, post, resolve or close anything."
        actions={
          can('assistant:invoke') && (
            <Button
              busy={analyzeState.loading}
              onClick={async () => {
                await analyze({
                  variables: { exceptionId: exception.id },
                  refetchQueries: [{ query: EXCEPTION_DETAIL, variables: { id: exception.id } }],
                  awaitRefetchQueries: true,
                });
              }}
              testId="analyze"
            >
              {latestRun ? 'Analyse again' : 'Analyse'}
            </Button>
          )
        }
      >
        {!latestRun ? (
          <EmptyState
            title="No analysis yet"
            description="Ask the assistant to summarise what the records show. It will cite the records it used."
          />
        ) : latestRun.status !== 'SUCCEEDED' || !latestRun.analysis ? (
          <ErrorState
            title="The assistant could not complete this analysis"
            message={latestRun.errorMessage ?? 'No further detail was recorded.'}
          />
        ) : (
          <div className="space-y-4 p-4 text-sm">
            <Section title="Summary">
              <p className="text-ink-800">{latestRun.analysis.summary}</p>
            </Section>

            <Section title="Supporting records">
              {latestRun.analysis.supportingRecords.length === 0 ? (
                <p className="text-ink-500">No records were cited.</p>
              ) : (
                <ul className="space-y-1">
                  {latestRun.analysis.supportingRecords.map((record, index) => (
                    <li key={index} className="text-ink-700">
                      <span className="rounded bg-ink-100 px-1 py-0.5 text-2xs font-medium">
                        {record.recordType}
                      </span>{' '}
                      {record.label}
                      <span className="ml-1 font-mono text-2xs text-ink-400">
                        {record.recordId}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Possible explanations">
              <List items={latestRun.analysis.possibleExplanations} />
            </Section>

            <Section title="Recommended next steps">
              <List items={latestRun.analysis.recommendedNextSteps} />
            </Section>

            <Section title="Missing information">
              <List items={latestRun.analysis.missingInformation} />
            </Section>

            <details>
              <summary className="cursor-pointer text-xs font-medium text-accent-700">
                Tool calls ({latestRun.toolCalls.length}) · {latestRun.provider}/{latestRun.model} ·
                prompt {latestRun.promptVersion} · {latestRun.durationMs}ms
              </summary>
              <ul className="mt-2 space-y-1 text-xs">
                {latestRun.toolCalls.map((call) => (
                  <li key={call.sequence} className="flex gap-2">
                    <span className="tabular w-5 text-ink-400">{call.sequence}</span>
                    <span className="font-mono">{call.toolName}</span>
                    <span className={call.allowed ? 'text-positive-600' : 'text-critical-600'}>
                      {call.allowed ? 'allowed' : `denied: ${call.denialReason}`}
                    </span>
                    {call.resultSummary && (
                      <span className="text-ink-500">{call.resultSummary}</span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </Panel>

      {exception.status !== 'RESOLVED' && can('exception:resolve') && (
        <Panel
          title="Resolve"
          description="A resolution must match what actually happened to the money. Claiming an action that was not taken is rejected."
        >
          <div className="space-y-3 p-4">
            <Field label="Resolution">
              <select
                className="input"
                value={resolution}
                onChange={(event) => setResolution(event.target.value)}
                data-testid="resolution"
              >
                <option value="">Choose…</option>
                {RESOLUTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>

            {RESOLUTIONS.find((option) => option.value === resolution)?.needsAction && (
              <p className="rounded border border-accent-200 bg-accent-50 px-3 py-2 text-xs text-ink-700">
                This resolution asserts a financial action was taken. The server checks the records
                and rejects it if no matching allocation, reversal or credit exists.
              </p>
            )}

            <Field label="Reason">
              <textarea
                className="input min-h-[72px]"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="What was decided and why"
                data-testid="resolution-reason"
              />
            </Field>

            <Button
              variant="primary"
              disabled={!resolution || reason.trim().length < 4}
              busy={resolveState.loading}
              onClick={() => void onResolve()}
              testId="resolve"
            >
              Resolve exception
            </Button>
          </div>
        </Panel>
      )}

      <Panel title="Comments">
        <ul className="divide-y divide-ink-100">
          {exception.comments.map((entry) => (
            <li key={entry.id} className="px-4 py-3 text-sm">
              <p className="text-ink-800">{entry.body}</p>
              <p className="mt-1 text-xs text-ink-500">
                {entry.authorName} · {formatInstant(entry.createdAt)}
              </p>
            </li>
          ))}
          {exception.comments.length === 0 && (
            <li className="px-4 py-3 text-sm text-ink-500">No comments yet.</li>
          )}
        </ul>

        <div className="flex gap-2 border-t border-ink-200 p-3">
          <input
            className="input"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Add a note for whoever picks this up next"
            aria-label="Comment"
          />
          <Button
            busy={commentState.loading}
            disabled={comment.trim().length === 0}
            onClick={async () => {
              await addComment({
                variables: { input: { exceptionId: exception.id, body: comment.trim() } },
                refetchQueries: [{ query: EXCEPTION_DETAIL, variables: { id: exception.id } }],
              });
              setComment('');
            }}
          >
            Comment
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="field-label">{title}</h3>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function List({ items }: { items: string[] }) {
  if (items.length === 0) return <p className="text-ink-500">None.</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-ink-800">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

interface ExceptionRow {
  id: string;
  category: string;
  status: string;
  severity: string;
  summary: string;
  isBlocking: boolean;
  openAmount: Money;
  assignedTo: { displayName: string } | null;
}

interface ExceptionDetailShape extends ExceptionRow {
  period: string;
  version: number;
  createdAt: string;
  resolution: string | null;
  resolutionReason: string | null;
  property: { id: string; code: string; name: string };
  transaction: {
    id: string;
    amount: Money;
    unappliedAmount: Money;
    postedDate: string;
    reference: string | null;
    description: string | null;
  } | null;
  candidateCharges: {
    id: string;
    description: string;
    dueDate: string;
    openBalance: Money;
    tenant: { displayName: string };
  }[];
  comments: { id: string; body: string; authorName: string; createdAt: string }[];
  assistantRuns: {
    id: string;
    status: string;
    provider: string;
    model: string;
    promptVersion: string;
    durationMs: number | null;
    errorMessage: string | null;
    analysis: {
      summary: string;
      possibleExplanations: string[];
      recommendedNextSteps: string[];
      missingInformation: string[];
      supportingRecords: { recordType: string; recordId: string; label: string }[];
    } | null;
    toolCalls: {
      sequence: number;
      toolName: string;
      allowed: boolean;
      denialReason: string | null;
      resultSummary: string | null;
    }[];
  }[];
}
