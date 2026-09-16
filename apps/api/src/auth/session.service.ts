/**
 * Server-side sessions.
 *
 * The cookie carries an opaque random id and nothing else. All authority lives
 * in the `sessions` row, so revoking a session is immediate and a stolen cookie
 * stops working the moment it is revoked — neither of which is true of a
 * self-contained token.
 *
 * Cookie flags: HttpOnly (JavaScript cannot read it), SameSite (cross-site
 * requests do not carry it), Secure in production, and a matching expiry.
 * CSRF protection is a separate double-submit token, because SameSite=lax alone
 * does not cover every browser and proxy arrangement.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { DomainError, MembershipStatus, type AccessContext, type Role } from '@rentwell/domain';
import { PrismaService } from '../prisma/prisma.service';
import { API_CONFIG, type ApiConfig } from '../config/configuration';
import { generateToken, safeEquals } from './password';

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly access: AccessContext;
}

export const CSRF_HEADER = 'x-csrf-token';

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private cookieOptions(maxAgeMs: number): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.session.secure,
      sameSite: this.config.session.sameSite,
      path: '/',
      maxAge: maxAgeMs,
    };
  }

  /** Creates a session row and sets both cookies on the response. */
  async create(
    res: Response,
    req: Request,
    userId: string,
    organizationId: string,
  ): Promise<AuthenticatedSession> {
    const sessionId = generateToken(32);
    const csrfToken = generateToken(24);
    const ttlMs = this.config.session.ttlHours * 3_600_000;
    const expiresAt = new Date(Date.now() + ttlMs);

    await this.prisma.client.session.create({
      data: {
        id: sessionId,
        userId,
        organizationId,
        csrfToken,
        userAgent: truncate(req.get('user-agent'), 300),
        ipAddress: truncate(clientIp(req), 60),
        expiresAt,
      },
    });

    res.cookie(this.config.session.cookieName, sessionId, this.cookieOptions(ttlMs));
    // Readable by the client so it can echo the value in a header. This is the
    // double-submit pattern: knowing the value requires same-origin access.
    res.cookie(this.config.session.csrfCookieName, csrfToken, {
      ...this.cookieOptions(ttlMs),
      httpOnly: false,
    });

    const access = await this.buildAccessContext(userId, organizationId);
    return { sessionId, csrfToken, access };
  }

  /** Resolves the session on an incoming request, or null when there is none. */
  async resolve(req: Request): Promise<AuthenticatedSession | null> {
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const sessionId = cookies[this.config.session.cookieName];
    if (!sessionId) return null;

    const session = await this.prisma.client.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        organizationId: true,
        csrfToken: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    if (!session) return null;
    if (session.revokedAt !== null) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;

    const access = await this.buildAccessContext(session.userId, session.organizationId);

    // Touch at most once a minute: a write on every request would make the
    // sessions table the busiest one in the database for no benefit.
    void this.touch(session.id);

    return { sessionId: session.id, csrfToken: session.csrfToken, access };
  }

  private lastTouched = new Map<string, number>();

  private async touch(sessionId: string): Promise<void> {
    const previous = this.lastTouched.get(sessionId) ?? 0;
    if (Date.now() - previous < 60_000) return;
    this.lastTouched.set(sessionId, Date.now());
    try {
      await this.prisma.client.session.update({
        where: { id: sessionId },
        data: { lastSeenAt: new Date() },
      });
    } catch {
      // A session deleted mid-request is not an error worth failing over.
    }
  }

  async revoke(sessionId: string, res: Response): Promise<void> {
    await this.prisma.client.session
      .update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
      .catch(() => undefined);

    res.clearCookie(this.config.session.cookieName, { path: '/' });
    res.clearCookie(this.config.session.csrfCookieName, { path: '/' });
    this.lastTouched.delete(sessionId);
  }

  /** Revokes every session for a user, used when a role or status changes. */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.prisma.client.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /**
   * Loads role, membership status and property assignments into the shape the
   * domain's authorization functions expect.
   */
  async buildAccessContext(userId: string, organizationId: string): Promise<AccessContext> {
    const membership = await this.prisma.client.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: {
        role: true,
        status: true,
        user: { select: { disabledAt: true } },
        assignments: { select: { propertyId: true } },
      },
    });

    if (!membership) {
      throw new DomainError('FORBIDDEN', 'This account has no membership in that organization');
    }
    if (membership.user.disabledAt !== null) {
      throw new DomainError('FORBIDDEN', 'This account is disabled');
    }

    return {
      userId,
      organizationId,
      role: membership.role as Role,
      membershipStatus: membership.status as MembershipStatus,
      assignedPropertyIds: new Set(membership.assignments.map((row) => row.propertyId)),
    };
  }

  /**
   * Enforces the CSRF double-submit on state-changing requests.
   *
   * The header must match the token stored with the session. A cross-site page
   * can make the browser send the cookie, but cannot read it to set the header.
   */
  assertCsrf(req: Request, expectedToken: string | null): void {
    if (expectedToken === null) return; // No session: nothing to protect yet.

    const header = req.get(CSRF_HEADER);
    if (!header || !safeEquals(header, expectedToken)) {
      throw new DomainError(
        'FORBIDDEN',
        'Missing or invalid CSRF token. Reload the page and try again.',
        { details: { header: CSRF_HEADER } },
      );
    }
  }

  /** Deletes expired and long-revoked rows. Run by the maintenance job. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.client.session.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          { revokedAt: { lt: new Date(now.getTime() - 7 * 86_400_000) } },
        ],
      },
    });
    return result.count;
  }
}

function truncate(value: string | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function clientIp(req: Request): string | undefined {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return req.ip;
}
