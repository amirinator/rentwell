/**
 * Per-request context.
 *
 * Built once per HTTP request and handed to every resolver. It carries the
 * authenticated principal (or nothing, for an anonymous request), the
 * correlation id, per-request DataLoaders, and the response object needed to
 * set cookies on sign-in and sign-out.
 *
 * Resolvers never read `req.user` or a global. Authorization always starts from
 * `ctx.access`, which is `null` until authentication has actually succeeded.
 */

import type { Request, Response } from 'express';
import type { AccessContext } from '@rentwell/domain';
import type { Logger } from '@rentwell/observability';
import type { Loaders } from './loaders';

export interface RequestContext {
  /** Null for an unauthenticated request. Guards turn that into UNAUTHENTICATED. */
  readonly access: AccessContext | null;
  readonly correlationId: string;
  readonly logger: Logger;
  readonly loaders: Loaders;
  readonly req: Request;
  readonly res: Response;
  /** Session id, when one was presented and is valid. */
  readonly sessionId: string | null;
  /** Server-side CSRF token for this session, compared on mutations. */
  readonly csrfToken: string | null;
  readonly startedAt: number;
}

/** The context type resolvers see. Kept separate so tests can build one. */
export type GqlContext = RequestContext;
