import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CANCEL_IMPORT,
  CONFIRM_IMPORT,
  CREATE_IMPORT_UPLOAD,
  IMPORTS,
  IMPORT_DETAIL,
  PROPERTY_DETAIL,
  PROPERTIES,
  RETRY_IMPORT,
  VALIDATE_IMPORT,
} from '../graphql/operations';
import { defaultPeriod, useFilters } from '../hooks/useFilters';
import { useSession } from '../lib/session';
import { useToast } from '../components/Toast';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Panel,
  StatusBadge,
  formatInstant,
} from '../components/ui';
import { Pager } from './PortfolioOverview';

/**
 * Import center.
 *
 * The flow is upload → validate → confirm, and confirmation quotes the hash
 * validation returned. That binding is what stops a file being swapped after it
 * was reviewed, so the UI keeps the hash from validation and sends it back
 * rather than re-reading it from the server.
 */
export function ImportCenter() {
  const { importId } = useParams<{ importId: string }>();

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <div className="space-y-4">
        <UploadPanel />
        <ImportList selectedId={importId ?? null} />
      </div>
      {importId ? (
        <ImportDetail importId={importId} />
      ) : (
        <Panel title="Select an import">
          <EmptyState
            title="Nothing selected"
            description="Choose an import to see its progress, its row outcomes and any validation errors."
          />
        </Panel>
      )}
    </div>
  );
}

function UploadPanel() {
  const { can } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);

  const [propertyId, setPropertyId] = useState('');
  const [bankAccountId, setBankAccountId] = useState('');
  const [busy, setBusy] = useState(false);

  const propertiesQuery = useQuery(PROPERTIES, { variables: { first: 50 } });
  const propertyQuery = useQuery(PROPERTY_DETAIL, {
    variables: { id: propertyId, period: defaultPeriod() },
    skip: !propertyId,
  });

  const [createUpload] = useMutation(CREATE_IMPORT_UPLOAD);

  if (!can('import:create')) return null;

  const properties: { id: string; code: string; name: string }[] =
    propertiesQuery.data?.properties.edges.map(
      (edge: { node: { id: string; code: string; name: string } }) => edge.node,
    ) ?? [];

  const bankAccounts: { id: string; label: string; maskedNumber: string }[] =
    propertyQuery.data?.property?.bankAccounts ?? [];

  const upload = async () => {
    const file = fileInput.current?.files?.[0];
    if (!file || !propertyId || !bankAccountId) return;

    setBusy(true);
    try {
      const created = await createUpload({
        variables: {
          input: {
            propertyId,
            bankAccountId,
            filename: file.name,
            fileSizeBytes: file.size,
          },
        },
      });

      const ticket = created.data?.createImportUpload;
      if (!ticket) return;

      // The file goes straight to object storage using a URL the server signed
      // for one specific key, so the bytes never pass through the API.
      const response = await fetch(ticket.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': 'text/csv' },
      });

      if (!response.ok) {
        toast.push({
          tone: 'error',
          title: 'Upload failed',
          detail: `Storage rejected the file (${response.status}).`,
        });
        return;
      }

      toast.push({ tone: 'success', title: 'Uploaded', detail: 'Validate it to see any errors.' });
      navigate(`/imports/${ticket.importId}`);
      if (fileInput.current) fileInput.current.value = '';
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Upload a statement"
      description="CSV only. Nothing is imported until you confirm."
    >
      <div className="space-y-3 p-4">
        <Field label="Property">
          <select
            className="input"
            value={propertyId}
            onChange={(event) => {
              setPropertyId(event.target.value);
              setBankAccountId('');
            }}
            data-testid="import-property"
          >
            <option value="">Choose…</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.code} — {property.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Bank account">
          <select
            className="input"
            value={bankAccountId}
            onChange={(event) => setBankAccountId(event.target.value)}
            disabled={!propertyId}
            data-testid="import-account"
          >
            <option value="">Choose…</option>
            {bankAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label} (…{account.maskedNumber})
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="File"
          hint="Expected header: external_id,posted_date,amount,currency,reference,description"
        >
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            className="input"
            data-testid="import-file"
          />
        </Field>

        <Button
          variant="primary"
          busy={busy}
          disabled={!propertyId || !bankAccountId}
          onClick={() => void upload()}
          testId="upload"
        >
          Upload
        </Button>
      </div>
    </Panel>
  );
}

function ImportList({ selectedId }: { selectedId: string | null }) {
  const { cursor, setCursor } = useFilters({});
  const { data, loading, error, refetch } = useQuery(IMPORTS, {
    variables: { first: 20, after: cursor },
    pollInterval: 5_000,
  });

  const connection = data?.imports;

  return (
    <Panel title="Imports" description={connection ? `${connection.totalCount} total` : undefined}>
      {loading && !connection && <LoadingState />}
      {error && !connection && (
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      )}
      {connection && connection.edges.length === 0 && (
        <EmptyState title="No imports yet" description="Upload a statement to get started." />
      )}

      {connection && connection.edges.length > 0 && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Property</th>
                <th>Status</th>
                <th className="text-right">Progress</th>
              </tr>
            </thead>
            <tbody>
              {connection.edges.map(({ node }: { node: ImportRow }) => (
                <tr
                  key={node.id}
                  className={node.id === selectedId ? 'bg-accent-100/60' : undefined}
                >
                  <td>
                    <Link to={`/imports/${node.id}`} className="text-accent-700 hover:underline">
                      {node.originalFilename}
                    </Link>
                    <span className="block text-xs text-ink-500">
                      {formatInstant(node.createdAt)}
                    </span>
                  </td>
                  <td className="text-ink-600">{node.property.code}</td>
                  <td>
                    <StatusBadge status={node.status} />
                  </td>
                  <td className="tabular text-right text-xs">
                    {node.totalRows > 0 ? `${node.processedRows}/${node.totalRows}` : '—'}
                    {node.failedRows > 0 && (
                      <span className="ml-1 text-critical-700">({node.failedRows} failed)</span>
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

function ImportDetail({ importId }: { importId: string }) {
  const { can } = useSession();
  const toast = useToast();
  const [validatedHash, setValidatedHash] = useState<string | null>(null);

  const { data, loading, error, refetch } = useQuery(IMPORT_DETAIL, {
    variables: { id: importId },
    // Polling so progress advances while the worker runs, which is the point
    // of showing processed/total at all.
    pollInterval: 3_000,
  });

  const [validate, validateState] = useMutation(VALIDATE_IMPORT);
  const [confirm, confirmState] = useMutation(CONFIRM_IMPORT);
  const [cancel, cancelState] = useMutation(CANCEL_IMPORT);
  const [retry, retryState] = useMutation(RETRY_IMPORT);

  const batch = data?.importBatch as ImportDetailShape | undefined;

  if (loading && !batch)
    return (
      <Panel>
        <LoadingState />
      </Panel>
    );
  if (error && !batch) {
    return (
      <Panel>
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      </Panel>
    );
  }
  if (!batch)
    return (
      <Panel>
        <EmptyState title="Import not found" />
      </Panel>
    );

  const refetchList = [
    { query: IMPORT_DETAIL, variables: { id: importId } },
    { query: IMPORTS, variables: { first: 20, after: null } },
  ];

  const canConfirm = batch.status === 'READY' && (validatedHash ?? batch.fileHash);

  return (
    <div className="space-y-4">
      <Panel
        title={batch.originalFilename}
        description={`${batch.property.code} · ${batch.bankAccount.label}`}
        actions={<StatusBadge status={batch.status} />}
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 text-sm md:grid-cols-4">
          <Stat label="Rows" value={batch.totalRows} />
          <Stat label="Processed" value={batch.processedRows} />
          <Stat label="Created" value={batch.createdRows} />
          <Stat label="Duplicates" value={batch.duplicateRows} />
          <Stat
            label="Failed"
            value={batch.failedRows}
            tone={batch.failedRows > 0 ? 'bad' : undefined}
          />
          <Stat label="Resume point" value={batch.checkpointRow} />
          <Stat label="Attempts" value={batch.attempts} />
          <div>
            <dt className="field-label">File hash</dt>
            <dd className="mt-0.5 truncate font-mono text-2xs" title={batch.fileHash}>
              {batch.fileHash ? `${batch.fileHash.slice(0, 16)}…` : '—'}
            </dd>
          </div>
        </dl>

        {batch.errorMessage && (
          <div className="border-t border-ink-200 bg-critical-100 px-4 py-3 text-sm text-critical-800">
            {batch.errorMessage}
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t border-ink-200 px-4 py-3">
          {can('import:create') &&
            ['DRAFT', 'VALIDATION_FAILED', 'READY'].includes(batch.status) && (
              <Button
                busy={validateState.loading}
                onClick={async () => {
                  const result = await validate({
                    variables: { importId },
                    refetchQueries: refetchList,
                    awaitRefetchQueries: true,
                  });
                  const hash = result.data?.validateImport?.fileHash;
                  if (hash) setValidatedHash(hash);
                }}
                testId="validate"
              >
                Validate
              </Button>
            )}

          {can('import:confirm') && canConfirm && (
            <Button
              variant="primary"
              busy={confirmState.loading}
              onClick={async () => {
                const result = await confirm({
                  variables: {
                    input: {
                      importId,
                      // The hash validation returned. If the object changed
                      // since, the server refuses rather than importing bytes
                      // nobody reviewed.
                      fileHash: validatedHash ?? batch.fileHash,
                      idempotencyKey: crypto.randomUUID(),
                    },
                  },
                  refetchQueries: refetchList,
                  awaitRefetchQueries: true,
                });
                if (!result.errors?.length) {
                  toast.push({
                    tone: 'success',
                    title: 'Import queued',
                    detail: 'The worker processes it in resumable batches.',
                  });
                }
              }}
              testId="confirm-import"
            >
              Confirm and import {batch.totalRows} rows
            </Button>
          )}

          {can('import:cancel') &&
            ['DRAFT', 'VALIDATING', 'READY', 'VALIDATION_FAILED'].includes(batch.status) && (
              <Button
                busy={cancelState.loading}
                onClick={async () => {
                  await cancel({ variables: { importId }, refetchQueries: refetchList });
                }}
              >
                Cancel
              </Button>
            )}

          {can('import:confirm') && batch.status === 'FAILED' && (
            <Button
              busy={retryState.loading}
              onClick={async () => {
                await retry({ variables: { importId }, refetchQueries: refetchList });
                toast.push({
                  tone: 'info',
                  title: 'Retry queued',
                  detail: `Resuming from row ${batch.checkpointRow}. Rows already imported are not repeated.`,
                });
              }}
              testId="retry-import"
            >
              Retry from row {batch.checkpointRow}
            </Button>
          )}

          {batch.downloadUrl && (
            <a
              href={batch.downloadUrl}
              className="inline-flex items-center rounded-md border border-ink-300 px-3 py-1.5 text-sm hover:bg-ink-50"
            >
              Download source file
            </a>
          )}
        </div>
      </Panel>

      {batch.validationErrors.length > 0 && (
        <Panel
          title={`Validation errors (${batch.validationErrors.length})`}
          description="Every error must be corrected before this file can be confirmed."
        >
          <div className="max-h-80 overflow-y-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Column</th>
                  <th>Problem</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {batch.validationErrors.map((issue, index) => (
                  <tr key={index}>
                    <td className="tabular">{issue.rowNumber ?? '—'}</td>
                    <td className="font-mono text-xs">{issue.column ?? '—'}</td>
                    <td>{issue.message}</td>
                    <td className="font-mono text-xs text-ink-500">{issue.value ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {batch.rows.edges.length > 0 && (
        <Panel title="Row outcomes" description={`${batch.rows.totalCount} recorded`}>
          <div className="max-h-96 overflow-y-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>External id</th>
                  <th>Outcome</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {batch.rows.edges.map(({ node }) => (
                  <tr key={node.id}>
                    <td className="tabular">{node.rowNumber}</td>
                    <td className="font-mono text-xs">{node.externalId ?? '—'}</td>
                    <td>
                      <StatusBadge
                        status={node.outcome}
                        tone={
                          node.outcome === 'CREATED'
                            ? 'positive'
                            : node.outcome === 'DUPLICATE'
                              ? 'caution'
                              : 'critical'
                        }
                      />
                    </td>
                    <td className="text-xs text-ink-600">{node.message ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'bad' }) {
  return (
    <div>
      <dt className="field-label">{label}</dt>
      <dd className={`tabular mt-0.5 font-medium ${tone === 'bad' ? 'text-critical-700' : ''}`}>
        {value}
      </dd>
    </div>
  );
}

interface ImportRow {
  id: string;
  status: string;
  originalFilename: string;
  totalRows: number;
  processedRows: number;
  failedRows: number;
  createdAt: string;
  property: { code: string };
}

interface ImportDetailShape {
  id: string;
  status: string;
  originalFilename: string;
  fileHash: string;
  totalRows: number;
  processedRows: number;
  createdRows: number;
  duplicateRows: number;
  failedRows: number;
  checkpointRow: number;
  attempts: number;
  errorMessage: string | null;
  downloadUrl: string | null;
  property: { code: string; name: string };
  bankAccount: { label: string };
  validationErrors: {
    rowNumber: number | null;
    column: string | null;
    code: string;
    message: string;
    value: string | null;
  }[];
  rows: {
    totalCount: number;
    edges: {
      node: {
        id: string;
        rowNumber: number;
        externalId: string | null;
        outcome: string;
        message: string | null;
      };
    }[];
  };
}
