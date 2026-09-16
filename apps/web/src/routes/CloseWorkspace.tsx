import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import {
  CLOSE_PERIOD,
  CLOSE_READINESS,
  CLOSE_SNAPSHOTS,
  PROPERTIES,
  PROPERTY_DETAIL,
  REOPEN_PERIOD,
  START_PERIOD_REVIEW,
} from '../graphql/operations';
import { defaultPeriod, useFilters } from '../hooks/useFilters';
import { useSession } from '../lib/session';
import { useToast } from '../components/Toast';
import {
  Amount,
  Button,
  DefinitionRow,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Panel,
  StatusBadge,
  formatInstant,
  humanize,
  type Money,
} from '../components/ui';

/**
 * Close workspace.
 *
 * The checklist is the screen. Blockers cannot be ticked past; acknowledgements
 * must be accepted explicitly, and the ones that require a reason will not
 * submit without one. The confirmation restates the totals being frozen before
 * anything is committed.
 */
export function CloseWorkspace() {
  const { filters, setFilters } = useFilters({ propertyId: '', period: defaultPeriod() });
  const propertiesQuery = useQuery(PROPERTIES, { variables: { first: 50 } });

  const properties: { id: string; code: string; name: string }[] =
    propertiesQuery.data?.properties.edges.map(
      (edge: { node: { id: string; code: string; name: string } }) => edge.node,
    ) ?? [];

  const propertyId = filters.propertyId || properties[0]?.id || '';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">Month-end close</h1>
          <p className="text-sm text-ink-500">
            Every condition is re-checked inside the closing transaction, so nothing can post past a
            close.
          </p>
        </div>

        <div className="flex items-end gap-3">
          <Field label="Property">
            <select
              className="input w-64"
              value={propertyId}
              onChange={(event) => setFilters({ propertyId: event.target.value })}
              data-testid="close-property"
            >
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.code} — {property.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Period">
            <input
              type="month"
              className="input w-40"
              value={filters.period}
              onChange={(event) => setFilters({ period: event.target.value })}
              data-testid="close-period"
            />
          </Field>
        </div>
      </div>

      {propertyId ? (
        <>
          <CloseChecklist propertyId={propertyId} period={filters.period} />
          <SnapshotHistory propertyId={propertyId} />
        </>
      ) : (
        <Panel>
          <EmptyState
            title="No properties available"
            description="You are not assigned to any property."
          />
        </Panel>
      )}
    </div>
  );
}

function CloseChecklist({ propertyId, period }: { propertyId: string; period: string }) {
  const { can } = useSession();
  const toast = useToast();
  const [acknowledged, setAcknowledged] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);

  const readinessQuery = useQuery(CLOSE_READINESS, {
    variables: { propertyId, period },
    fetchPolicy: 'cache-and-network',
  });

  // The period's version is needed for the optimistic-concurrency check, and it
  // lives on the property's period record rather than on readiness.
  const periodQuery = useQuery(PROPERTY_DETAIL, { variables: { id: propertyId, period } });

  const [startReview, startState] = useMutation(START_PERIOD_REVIEW);
  const [closePeriod, closeState] = useMutation(CLOSE_PERIOD);
  const [reopenPeriod, reopenState] = useMutation(REOPEN_PERIOD);

  const readiness = readinessQuery.data?.closeReadiness as Readiness | undefined;
  const periodRecord = periodQuery.data?.property?.period as
    { id: string; status: string; version: number } | undefined;

  if (readinessQuery.loading && !readiness) {
    return (
      <Panel>
        <LoadingState label="Evaluating close readiness" />
      </Panel>
    );
  }
  if (readinessQuery.error && !readiness) {
    return (
      <Panel>
        <ErrorState
          message={readinessQuery.error.message}
          onRetry={() => void readinessQuery.refetch()}
        />
      </Panel>
    );
  }
  if (!readiness)
    return (
      <Panel>
        <EmptyState title="No readiness data" />
      </Panel>
    );

  const refetchAll = [
    { query: CLOSE_READINESS, variables: { propertyId, period } },
    { query: PROPERTY_DETAIL, variables: { id: propertyId, period } },
    { query: CLOSE_SNAPSHOTS, variables: { propertyId } },
  ];

  const outstandingAcknowledgements = readiness.acknowledgements.filter(
    (item) => !(item.code in acknowledged),
  );
  const missingReasons = readiness.acknowledgements.filter(
    (item) => item.requiresReason && !(acknowledged[item.code] ?? '').trim(),
  );

  const readyToSubmit =
    readiness.canClose &&
    readiness.periodStatus === 'IN_REVIEW' &&
    outstandingAcknowledgements.length === 0 &&
    missingReasons.length === 0;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Panel
          title={`${readiness.property.code} · ${readiness.period}`}
          description={`Evaluated ${formatInstant(readiness.evaluatedAt)}`}
          actions={<StatusBadge status={readiness.periodStatus} />}
        >
          <div className="space-y-4 p-4">
            <div>
              <h3 className="text-sm font-semibold text-ink-900">
                Blockers ({readiness.blockers.length})
              </h3>
              {readiness.blockers.length === 0 ? (
                <p className="mt-1 text-sm text-positive-800">✓ Nothing is blocking this close.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {readiness.blockers.map((blocker) => (
                    <li
                      key={blocker.code}
                      className="rounded border border-critical-600/30 bg-critical-100 px-3 py-2"
                      data-testid={`blocker-${blocker.code}`}
                    >
                      <p className="text-sm font-medium text-critical-800">{blocker.message}</p>
                      <p className="mt-0.5 text-xs text-critical-800/80">
                        Resolve in: {blocker.resolutionHint}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3 className="text-sm font-semibold text-ink-900">
                Acknowledgements ({readiness.acknowledgements.length})
              </h3>
              <p className="mt-0.5 text-xs text-ink-500">
                These do not block the close, but a controller must accept each one, and some need a
                stated reason.
              </p>

              {readiness.acknowledgements.length === 0 ? (
                <p className="mt-2 text-sm text-ink-500">Nothing to acknowledge.</p>
              ) : (
                <ul className="mt-2 space-y-3">
                  {readiness.acknowledgements.map((item) => {
                    const checked = item.code in acknowledged;
                    return (
                      <li key={item.code} className="rounded border border-ink-200 p-3">
                        <label className="flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={checked}
                            onChange={(event) =>
                              setAcknowledged((current) => {
                                const next = { ...current };
                                if (event.target.checked) next[item.code] = '';
                                else delete next[item.code];
                                return next;
                              })
                            }
                            data-testid={`ack-${item.code}`}
                          />
                          <span>
                            <span className="font-medium text-ink-900">{humanize(item.code)}</span>
                            <span className="mt-0.5 block text-ink-700">{item.message}</span>
                          </span>
                        </label>

                        {checked && item.requiresReason && (
                          <input
                            className="input mt-2"
                            placeholder="Reason (required)"
                            value={acknowledged[item.code] ?? ''}
                            onChange={(event) =>
                              setAcknowledged((current) => ({
                                ...current,
                                [item.code]: event.target.value,
                              }))
                            }
                            data-testid={`ack-reason-${item.code}`}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-ink-200 px-4 py-3">
            {readiness.periodStatus === 'OPEN' && can('period:start_review') && (
              <Button
                variant="primary"
                busy={startState.loading}
                onClick={async () => {
                  await startReview({
                    variables: { input: { propertyId, period } },
                    refetchQueries: refetchAll,
                    awaitRefetchQueries: true,
                  });
                }}
                testId="start-review"
              >
                Start review
              </Button>
            )}

            {readiness.periodStatus === 'IN_REVIEW' && can('period:close') && (
              <>
                {confirming ? (
                  <div className="w-full space-y-3 rounded border border-accent-200 bg-accent-50 p-3">
                    <p className="text-sm font-medium text-ink-900">
                      Close {readiness.period} for {readiness.property.code}?
                    </p>
                    <dl className="text-sm">
                      <DefinitionRow term="Charges posted">
                        <Amount value={readiness.totals.chargesPosted} />
                      </DefinitionRow>
                      <DefinitionRow term="Payments received">
                        <Amount value={readiness.totals.paymentsReceived} />
                      </DefinitionRow>
                      <DefinitionRow term="Outstanding receivables">
                        <Amount value={readiness.totals.outstandingReceivables} />
                      </DefinitionRow>
                      <DefinitionRow term="Unapplied cash">
                        <Amount value={readiness.totals.unappliedCash} />
                      </DefinitionRow>
                    </dl>
                    <p className="text-xs text-ink-600">
                      These totals are stored in a snapshot. After the close, this period rejects
                      new postings until a controller reopens it with a stated reason.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="primary"
                        busy={closeState.loading}
                        onClick={async () => {
                          if (!periodRecord) return;
                          const result = await closePeriod({
                            variables: {
                              input: {
                                propertyId,
                                period,
                                acknowledgements: Object.entries(acknowledged).map(
                                  ([code, reason]) => ({ code, reason: reason.trim() || null }),
                                ),
                                expectedVersion: periodRecord.version,
                                idempotencyKey: crypto.randomUUID(),
                              },
                            },
                            refetchQueries: refetchAll,
                            awaitRefetchQueries: true,
                          });
                          if (!result.errors?.length) {
                            toast.push({ tone: 'success', title: `${period} closed` });
                            setConfirming(false);
                            setAcknowledged({});
                          }
                        }}
                        testId="confirm-close"
                      >
                        Close the period
                      </Button>
                      <Button onClick={() => setConfirming(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="primary"
                    disabled={!readyToSubmit}
                    title={
                      readyToSubmit
                        ? undefined
                        : 'Resolve every blocker and accept every acknowledgement first'
                    }
                    onClick={() => setConfirming(true)}
                    testId="close-period"
                  >
                    Close period
                  </Button>
                )}
              </>
            )}

            {readiness.periodStatus === 'CLOSED' && can('period:reopen') && (
              <Button
                variant="danger"
                busy={reopenState.loading}
                onClick={async () => {
                  const reason = window.prompt('Why is this period being reopened?');
                  if (!reason || reason.trim().length < 4 || !periodRecord) return;
                  const result = await reopenPeriod({
                    variables: {
                      input: {
                        propertyId,
                        period,
                        reason: reason.trim(),
                        expectedVersion: periodRecord.version,
                      },
                    },
                    refetchQueries: refetchAll,
                    awaitRefetchQueries: true,
                  });
                  if (!result.errors?.length) {
                    toast.push({
                      tone: 'warning',
                      title: `${period} reopened`,
                      detail: 'Previous close snapshots are kept.',
                    });
                  }
                }}
                testId="reopen-period"
              >
                Reopen period
              </Button>
            )}
          </div>
        </Panel>
      </div>

      <Panel title="Period totals">
        <dl>
          <DefinitionRow term="Charges posted">
            <Amount value={readiness.totals.chargesPosted} />
          </DefinitionRow>
          <DefinitionRow term="Payments received">
            <Amount value={readiness.totals.paymentsReceived} />
          </DefinitionRow>
          <DefinitionRow term="Payments allocated">
            <Amount value={readiness.totals.paymentsAllocated} />
          </DefinitionRow>
          <DefinitionRow term="Outstanding receivables">
            <Amount value={readiness.totals.outstandingReceivables} />
          </DefinitionRow>
          <DefinitionRow term="Unapplied cash">
            <Amount value={readiness.totals.unappliedCash} />
          </DefinitionRow>
        </dl>
      </Panel>
    </div>
  );
}

function SnapshotHistory({ propertyId }: { propertyId: string }) {
  const { data, loading } = useQuery(CLOSE_SNAPSHOTS, { variables: { propertyId } });
  const snapshots = (data?.closeSnapshots ?? []) as Snapshot[];

  return (
    <Panel
      title="Close history"
      description="Reopening a period keeps every earlier snapshot; a later close adds another."
    >
      {loading && snapshots.length === 0 && <LoadingState />}
      {!loading && snapshots.length === 0 && (
        <EmptyState title="No periods have been closed for this property yet." />
      )}
      {snapshots.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Closed</th>
              <th>By</th>
              <th className="text-right">Outstanding</th>
              <th className="text-right">Unapplied</th>
              <th>Checklist</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((snapshot) => (
              <tr key={snapshot.id}>
                <td className="font-medium">{snapshot.period}</td>
                <td>{formatInstant(snapshot.closedAt)}</td>
                <td className="text-ink-600">{snapshot.closedBy.displayName}</td>
                <td className="text-right">
                  <Amount value={snapshot.totals.outstandingReceivables} />
                </td>
                <td className="text-right">
                  <Amount value={snapshot.totals.unappliedCash} showZeroAs="—" />
                </td>
                <td>
                  <details>
                    <summary className="cursor-pointer text-xs text-accent-700">
                      {snapshot.checklist.length} item(s)
                    </summary>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {snapshot.checklist.map((item) => (
                        <li key={item.code}>
                          <span
                            className={item.satisfied ? 'text-positive-600' : 'text-critical-600'}
                          >
                            {item.satisfied ? '✓' : '✕'}
                          </span>{' '}
                          {item.message}
                          {item.reason && <span className="text-ink-500"> — {item.reason}</span>}
                        </li>
                      ))}
                    </ul>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

interface Readiness {
  period: string;
  periodStatus: string;
  canClose: boolean;
  evaluatedAt: string;
  property: { id: string; code: string; name: string };
  blockers: { code: string; message: string; count: number | null; resolutionHint: string }[];
  acknowledgements: {
    code: string;
    message: string;
    requiresReason: boolean;
    amount: Money | null;
  }[];
  totals: {
    chargesPosted: Money;
    paymentsReceived: Money;
    paymentsAllocated: Money;
    outstandingReceivables: Money;
    unappliedCash: Money;
  };
}

interface Snapshot {
  id: string;
  period: string;
  closedAt: string;
  closedBy: { displayName: string };
  totals: { outstandingReceivables: Money; unappliedCash: Money };
  checklist: { code: string; satisfied: boolean; message: string; reason: string | null }[];
}
