/**
 * Interface primitives.
 *
 * Two rules run through all of them:
 *
 *  1. **Status is never colour alone.** Every badge carries a word, and the
 *     severity ones carry a glyph as well, so the screen works in greyscale and
 *     for anyone who does not distinguish the hues.
 *  2. **Amounts are tabular and signed explicitly.** A negative figure is shown
 *     with a minus and a colour, never with colour alone, and the whole column
 *     aligns on the decimal point.
 */

import type { ReactNode } from 'react';

export interface Money {
  cents: number;
  currency: string;
  formatted: string;
}

// --------------------------------------------------------------------------
// Money
// --------------------------------------------------------------------------

export function Amount({
  value,
  emphasis = 'normal',
  showZeroAs,
}: {
  value: Money | null | undefined;
  emphasis?: 'normal' | 'strong' | 'muted';
  /** Rendered instead of "0.00" when the value is zero, e.g. an em dash. */
  showZeroAs?: string;
}) {
  if (!value) return <span className="text-ink-400">—</span>;

  if (value.cents === 0 && showZeroAs) {
    return <span className="tabular text-ink-400">{showZeroAs}</span>;
  }

  const weight =
    emphasis === 'strong' ? 'font-semibold' : emphasis === 'muted' ? 'text-ink-500' : '';
  // A negative amount is a credit or a reversal. It gets a colour *and* the
  // minus sign the formatter already produced.
  const tone = value.cents < 0 ? 'text-critical-600' : '';

  return (
    <span className={`tabular whitespace-nowrap ${weight} ${tone}`.trim()}>
      {value.formatted}
      <span className="ml-1 text-2xs text-ink-400">{value.currency}</span>
    </span>
  );
}

// --------------------------------------------------------------------------
// Status
// --------------------------------------------------------------------------

type Tone = 'neutral' | 'positive' | 'caution' | 'critical' | 'info';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-ink-100 text-ink-700 border-ink-200',
  positive: 'bg-positive-100 text-positive-800 border-positive-600/20',
  caution: 'bg-caution-100 text-caution-800 border-caution-600/20',
  critical: 'bg-critical-100 text-critical-800 border-critical-600/20',
  info: 'bg-accent-100 text-accent-900 border-accent-600/20',
};

/** Glyphs, so severity survives greyscale printing and colour blindness. */
const TONE_GLYPHS: Record<Tone, string> = {
  neutral: '',
  positive: '✓',
  caution: '!',
  critical: '✕',
  info: 'i',
};

const STATUS_TONES: Record<string, Tone> = {
  // Periods
  OPEN: 'info',
  IN_REVIEW: 'caution',
  CLOSED: 'neutral',
  // Charges
  POSTED: 'info',
  SETTLED: 'positive',
  VOIDED: 'neutral',
  // Payments
  UNAPPLIED: 'caution',
  PARTIALLY_ALLOCATED: 'caution',
  ALLOCATED: 'positive',
  REVERSED: 'critical',
  EXCLUDED: 'neutral',
  // Imports
  DRAFT: 'neutral',
  VALIDATING: 'info',
  READY: 'info',
  QUEUED: 'info',
  PROCESSING: 'info',
  COMPLETED: 'positive',
  VALIDATION_FAILED: 'critical',
  FAILED: 'critical',
  CANCELLED: 'neutral',
  // Exceptions
  ASSIGNED: 'info',
  RESOLVED: 'positive',
  LOW: 'neutral',
  MEDIUM: 'caution',
  HIGH: 'critical',
  CRITICAL: 'critical',
  // Suggestions
  PROPOSED: 'info',
  APPROVED: 'positive',
  REJECTED: 'neutral',
  SUPERSEDED: 'neutral',
  ACTIVE: 'positive',
};

export function humanize(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function StatusBadge({ status, tone }: { status: string; tone?: Tone }) {
  const resolved = tone ?? STATUS_TONES[status] ?? 'neutral';
  const glyph = TONE_GLYPHS[resolved];

  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs font-medium ${TONE_CLASSES[resolved]}`}
    >
      {glyph && (
        <span aria-hidden="true" className="font-bold">
          {glyph}
        </span>
      )}
      {humanize(status)}
    </span>
  );
}

// --------------------------------------------------------------------------
// Layout
// --------------------------------------------------------------------------

export function Panel({
  title,
  description,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`.trim()}>
      {(title || actions) && (
        <header className="panel-header">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink-900">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Metric({
  label,
  value,
  hint,
  to,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** Every summary figure links to the records behind it. */
  to?: string;
}) {
  const body = (
    <>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="mt-1 text-xl font-semibold text-ink-900">{value}</dd>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </>
  );

  if (!to) return <div className="panel p-4">{body}</div>;

  return (
    <a
      href={to}
      className="panel block p-4 transition hover:border-accent-300 hover:shadow-md focus-visible:border-accent-500"
    >
      {body}
    </a>
  );
}

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'secondary',
  disabled,
  busy,
  title,
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  testId?: string;
}) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';

  const variants: Record<string, string> = {
    primary: 'bg-accent-600 text-white hover:bg-accent-700',
    secondary: 'border border-ink-300 bg-white text-ink-800 hover:bg-ink-50',
    danger: 'border border-critical-600/30 bg-white text-critical-700 hover:bg-critical-100',
    ghost: 'text-ink-600 hover:bg-ink-100',
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      data-testid={testId}
      aria-busy={busy || undefined}
      className={`${base} ${variants[variant]}`}
    >
      {busy && (
        <span
          aria-hidden="true"
          className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}

// --------------------------------------------------------------------------
// States
// --------------------------------------------------------------------------

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-ink-500" role="status">
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-ink-300 border-t-accent-600"
      />
      {label}…
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="p-8 text-center">
      <p className="text-sm font-medium text-ink-800">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * Failure state.
 *
 * Shows the correlation id when the server supplied one, because that is what
 * turns "it broke" into a support request someone can act on.
 */
export function ErrorState({
  title = 'Something went wrong',
  message,
  correlationId,
  onRetry,
}: {
  title?: string;
  message: string;
  correlationId?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div className="p-6" role="alert">
      <p className="text-sm font-semibold text-critical-800">{title}</p>
      <p className="mt-1 text-sm text-ink-700">{message}</p>
      {correlationId && (
        <p className="mt-2 text-xs text-ink-500">
          Reference: <code className="rounded bg-ink-100 px-1 py-0.5">{correlationId}</code>
        </p>
      )}
      {onRetry && (
        <div className="mt-3">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      )}
    </div>
  );
}

/**
 * Marks data that is being refreshed.
 *
 * Financial screens say so rather than showing a stale figure as if it were
 * current: a number that is quietly out of date is worse than one that says it
 * is updating.
 */
export function StaleBanner({
  refreshedAt,
  isRefreshing,
}: {
  refreshedAt?: string;
  isRefreshing: boolean;
}) {
  if (!isRefreshing && !refreshedAt) return null;

  return (
    <p className="text-xs text-ink-500" aria-live="polite">
      {isRefreshing ? (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-accent-500" />
          Refreshing…
        </span>
      ) : (
        <>Last refreshed {refreshedAt ? new Date(refreshedAt).toLocaleTimeString() : 'just now'}</>
      )}
    </p>
  );
}

// --------------------------------------------------------------------------
// Misc
// --------------------------------------------------------------------------

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  // Business dates arrive as YYYY-MM-DD with no offset. Rendering them through
  // `new Date()` would shift the day in western timezones, so the parts are
  // formatted directly.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return new Date(value).toLocaleString();
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]}`;
}

export function formatInstant(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <span className="mt-1 block">{children}</span>
      {hint && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}
    </label>
  );
}

export function DefinitionRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-ink-100 px-4 py-2 text-sm last:border-b-0">
      <dt className="text-ink-500">{term}</dt>
      <dd className="text-right font-medium text-ink-900">{children}</dd>
    </div>
  );
}
