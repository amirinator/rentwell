/**
 * Transient notifications.
 *
 * Financial feedback is deliberately *not* transient: a completed allocation
 * updates the page, and a conflict is shown inline where the decision was made.
 * Toasts here are for the secondary kind of message — "regeneration queued",
 * "link copied" — and for errors that have no obvious inline home.
 *
 * Conflicts get a longer dwell time and stay until dismissed, because
 * "someone else changed this" is something the user must actually read.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { onDomainError } from '../apollo/client';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
  correlationId?: string | null;
  /** Milliseconds before auto-dismiss. Null means it stays until dismissed. */
  ttl: number | null;
}

interface ToastApi {
  push(toast: Omit<Toast, 'id' | 'ttl'> & { ttl?: number | null }): void;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Codes that mean "reload and look again", which must not disappear on a timer. */
const STICKY_CODES = new Set([
  'STALE_RECORD',
  'CONFLICT',
  'PERIOD_CLOSED',
  'IDEMPOTENCY_KEY_REUSED',
  'INSUFFICIENT_CHARGE_BALANCE',
  'INSUFFICIENT_PAYMENT_BALANCE',
  'CLOSE_BLOCKED',
  'EXCEPTION_UNRESOLVED',
]);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback<ToastApi['push']>((toast) => {
    const id = nextId++;
    const ttl = toast.ttl === undefined ? 6_000 : toast.ttl;
    setToasts((current) => [...current, { ...toast, id, ttl }].slice(-4));
  }, []);

  // Domain errors that reach the transport layer surface here, so a failure in
  // a background refetch is never silent.
  useEffect(
    () =>
      onDomainError((error) => {
        // Not signed in is a routing concern, not an error to announce.
        if (error.code === 'UNAUTHENTICATED') return;

        push({
          tone: STICKY_CODES.has(error.code) ? 'warning' : 'error',
          title: titleForCode(error.code),
          detail: error.message,
          correlationId: error.correlationId,
          ttl: STICKY_CODES.has(error.code) ? null : 8_000,
        });
      }),
    [push],
  );

  useEffect(() => {
    const timers = toasts
      .filter((toast) => toast.ttl !== null)
      .map((toast) => setTimeout(() => dismiss(toast.id), toast.ttl!));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismiss]);

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'error' || toast.tone === 'warning' ? 'alert' : 'status'}
            className={`pointer-events-auto rounded-lg border p-3 shadow-lg ${toneClasses(toast.tone)}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{toast.title}</p>
                {toast.detail && <p className="mt-0.5 text-xs opacity-90">{toast.detail}</p>}
                {toast.correlationId && (
                  <p className="mt-1 text-2xs opacity-70">Reference: {toast.correlationId}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="shrink-0 rounded p-0.5 text-lg leading-none opacity-60 hover:opacity-100"
                aria-label="Dismiss notification"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider');
  return context;
}

function toneClasses(tone: ToastTone): string {
  switch (tone) {
    case 'success':
      return 'border-positive-600/30 bg-positive-100 text-positive-800';
    case 'warning':
      return 'border-caution-600/30 bg-caution-100 text-caution-800';
    case 'error':
      return 'border-critical-600/30 bg-critical-100 text-critical-800';
    default:
      return 'border-ink-200 bg-white text-ink-800';
  }
}

/** Plain-language titles. The code is never shown to the user on its own. */
function titleForCode(code: string): string {
  switch (code) {
    case 'STALE_RECORD':
      return 'Someone else changed this';
    case 'CONFLICT':
      return 'This conflicts with another change';
    case 'PERIOD_CLOSED':
      return 'That accounting period is closed';
    case 'CLOSE_BLOCKED':
      return 'The period cannot be closed yet';
    case 'FORBIDDEN':
    case 'PROPERTY_NOT_ASSIGNED':
      return 'You do not have access to that';
    case 'NETWORK_ERROR':
      return 'Could not reach the server';
    case 'VALIDATION_FAILED':
      return 'Check the details and try again';
    default:
      return 'Something went wrong';
  }
}
