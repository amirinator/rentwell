/**
 * Apollo Client configuration.
 *
 * Three decisions worth stating:
 *
 *  1. **Credentials are included on every request.** The session lives in an
 *     HttpOnly cookie, so the browser must be allowed to send it. The CSRF
 *     token is read from its own readable cookie and echoed in a header, which
 *     is what a cross-site page cannot do.
 *  2. **Financial mutations never read from the cache.** A stale balance is
 *     worse than a slow one, so mutations declare the queries they invalidate
 *     and those refetch from the network.
 *  3. **Domain errors are surfaced, not swallowed.** The error link classifies
 *     them so a component can tell "this conflicts with someone else's change"
 *     from "the network is down" and say so.
 */

import { ApolloClient, ApolloLink, HttpLink, InMemoryCache, from } from '@apollo/client';
import { onError } from '@apollo/client/link/error';

export const CSRF_COOKIE = 'rentwell.csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const CORRELATION_HEADER = 'x-correlation-id';

export function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/\./g, '\\.')}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

/** Correlation ids the server returned, newest first. Shown in error details. */
export const recentCorrelationIds: string[] = [];

const httpLink = new HttpLink({
  uri: '/graphql',
  // The session cookie must travel with the request.
  credentials: 'include',
});

const csrfLink = new ApolloLink((operation, forward) => {
  const token = readCookie(CSRF_COOKIE);
  operation.setContext(({ headers = {} }: { headers?: Record<string, string> }) => ({
    headers: {
      ...headers,
      ...(token ? { [CSRF_HEADER]: token } : {}),
      // Apollo Server requires this header on POST as CSRF protection of its
      // own; sending it explicitly keeps the request valid behind proxies that
      // strip unknown headers.
      'apollo-require-preflight': 'true',
    },
  }));

  return forward(operation).map((response) => {
    const context = operation.getContext() as { response?: Response };
    const correlationId = context.response?.headers?.get(CORRELATION_HEADER);
    if (correlationId) {
      recentCorrelationIds.unshift(correlationId);
      recentCorrelationIds.length = Math.min(recentCorrelationIds.length, 20);
    }
    return response;
  });
});

export type ErrorListener = (error: {
  code: string;
  message: string;
  correlationId: string | null;
  retryable: boolean;
}) => void;

const listeners = new Set<ErrorListener>();

export function onDomainError(listener: ErrorListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const errorLink = onError(({ graphQLErrors, networkError }) => {
  for (const error of graphQLErrors ?? []) {
    const extensions = (error.extensions ?? {}) as {
      code?: string;
      correlationId?: string;
      retryable?: boolean;
    };
    for (const listener of listeners) {
      listener({
        code: extensions.code ?? 'INTERNAL_ERROR',
        message: error.message,
        correlationId: extensions.correlationId ?? null,
        retryable: extensions.retryable === true,
      });
    }
  }

  if (networkError) {
    for (const listener of listeners) {
      listener({
        code: 'NETWORK_ERROR',
        message: 'Could not reach the server. Your change was not saved.',
        correlationId: null,
        retryable: true,
      });
    }
  }
});

export const cache = new InMemoryCache({
  typePolicies: {
    Query: {
      fields: {
        // Connections are paginated by cursor; caching them by field name
        // alone would merge page 2 into page 1.
        properties: { keyArgs: ['search'] },
        receivables: { keyArgs: ['filter'] },
        transactions: { keyArgs: ['filter'] },
        exceptions: { keyArgs: ['filter'] },
        journalEntries: { keyArgs: ['filter'] },
        auditEvents: { keyArgs: ['filter'] },
        imports: { keyArgs: ['filter'] },
      },
    },
    // Money is a value, not an entity: normalising it would let two fields
    // with the same amount share a cache object and drift apart.
    Money: { keyFields: false },
    ScoreComponents: { keyFields: false },
    CloseTotals: { keyFields: false },
    MetricNote: { keyFields: false },
  },
});

export const apolloClient = new ApolloClient({
  link: from([errorLink, csrfLink, httpLink]),
  cache,
  defaultOptions: {
    watchQuery: {
      // Show what is cached, then reconcile with the server. Financial screens
      // additionally mark themselves stale while a refetch is in flight.
      fetchPolicy: 'cache-and-network',
      nextFetchPolicy: 'cache-first',
      errorPolicy: 'all',
    },
    query: { fetchPolicy: 'network-only', errorPolicy: 'all' },
    mutate: { errorPolicy: 'all' },
  },
});

/** Clears every cached record. Used on sign-out so nothing leaks to the next user. */
export async function resetClient(): Promise<void> {
  await apolloClient.clearStore();
}
