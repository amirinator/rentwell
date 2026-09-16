/**
 * Session state.
 *
 * The viewer query is the single source of truth for who is signed in. The
 * client never decides that from a cookie it can read, because the cookie it
 * can read is the CSRF token, not the session.
 *
 * `permissions` drives which controls render. It is advisory: the server checks
 * every action again when it is invoked, so hiding a button is a courtesy, not
 * a security boundary.
 */

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { SIGN_IN, SIGN_OUT, VIEWER } from '../graphql/operations';
import { resetClient } from '../apollo/client';

export interface Viewer {
  id: string;
  email: string;
  displayName: string;
  role: string;
  assignedPropertyIds: string[] | null;
  permissions: string[];
  organization: { id: string; name: string; slug: string; currency: string };
}

interface SessionApi {
  viewer: Viewer | null;
  loading: boolean;
  /** Throws on failure so the form can show the message inline. */
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  can(action: string): boolean;
  /** True when the viewer sees the whole organization rather than a subset. */
  seesWholePortfolio: boolean;
  refresh(): Promise<void>;
}

const SessionContext = createContext<SessionApi | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { data, loading, refetch } = useQuery<{ viewer: Viewer | null }>(VIEWER, {
    fetchPolicy: 'cache-and-network',
    // An anonymous request returns `viewer: null`, which is not an error.
    errorPolicy: 'all',
  });

  const [signInMutation] = useMutation(SIGN_IN);
  const [signOutMutation] = useMutation(SIGN_OUT);

  const viewer = data?.viewer ?? null;

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await signInMutation({ variables: { input: { email, password } } });

      if (result.errors && result.errors.length > 0) {
        throw new Error(result.errors[0]!.message);
      }

      // The cache is cleared before refetching so nothing from a previous
      // session survives into this one.
      await resetClient();
      await refetch();
    },
    [signInMutation, refetch],
  );

  const signOut = useCallback(async () => {
    await signOutMutation().catch(() => undefined);
    await resetClient();
    await refetch();
  }, [signOutMutation, refetch]);

  const permissions = useMemo(() => new Set(viewer?.permissions ?? []), [viewer]);

  const api = useMemo<SessionApi>(
    () => ({
      viewer,
      loading: loading && !viewer,
      signIn,
      signOut,
      can: (action: string) => permissions.has(action),
      seesWholePortfolio: viewer?.assignedPropertyIds === null,
      refresh: async () => {
        await refetch();
      },
    }),
    [viewer, loading, signIn, signOut, permissions, refetch],
  );

  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a SessionProvider');
  return context;
}

/**
 * Renders children only when the viewer holds the action.
 *
 * Used for affordances, never for data: a hidden panel is still fetched and
 * still authorized on the server.
 */
export function Can({
  action,
  children,
  fallback = null,
}: {
  action: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can } = useSession();
  return <>{can(action) ? children : fallback}</>;
}
