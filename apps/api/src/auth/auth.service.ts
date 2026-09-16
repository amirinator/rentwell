/**
 * Sign-in and viewer resolution.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  AuditAction,
  DomainError,
  MembershipStatus,
  allowedActions,
  isOrganizationScoped,
  type AccessContext,
} from '@rentwell/domain';
import { recordAuditEvent } from '@rentwell/database';
import type { Logger } from '@rentwell/observability';
import { PrismaService } from '../prisma/prisma.service';
import { API_CONFIG, type ApiConfig } from '../config/configuration';
import { LOGGER } from '../common/tokens';
import { SessionService, type AuthenticatedSession } from './session.service';
import { verifyAgainstDecoy, verifyPassword } from './password';

export interface MemberPayload {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  assignedProperties: { id: string; code: string; name: string }[];
}

export interface ViewerPayload {
  id: string;
  email: string;
  displayName: string;
  organization: { id: string; slug: string; name: string; currency: string };
  role: string;
  assignedPropertyIds: string[] | null;
  permissions: string[];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Authenticates an email and password.
   *
   * Every failure path returns the same message and does the same amount of
   * work: an unknown address is verified against a decoy hash so the response
   * time does not reveal whether the account exists.
   */
  async signIn(
    req: Request,
    res: Response,
    email: string,
    password: string,
    correlationId: string,
  ): Promise<AuthenticatedSession> {
    const normalizedEmail = email.trim().toLowerCase();

    const user = await this.prisma.client.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        passwordHash: true,
        disabledAt: true,
        memberships: {
          where: { status: MembershipStatus.ACTIVE },
          select: { organizationId: true, role: true },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });

    const failure = new DomainError('UNAUTHENTICATED', 'Email or password is incorrect');

    if (!user) {
      await verifyAgainstDecoy(this.config.password);
      this.logger.info(
        { correlationId, email: normalizedEmail },
        'Sign-in failed: unknown address',
      );
      throw failure;
    }

    const passwordMatches = await verifyPassword(user.passwordHash, password);

    if (!passwordMatches || user.disabledAt !== null || user.memberships.length === 0) {
      const membership = user.memberships[0];
      if (membership) {
        await this.recordSignInFailure(membership.organizationId, user.id, correlationId);
      }
      this.logger.info({ correlationId, userId: user.id }, 'Sign-in failed');
      throw failure;
    }

    const membership = user.memberships[0]!;
    const session = await this.sessions.create(res, req, user.id, membership.organizationId);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { lastSignedInAt: new Date() } });
      await recordAuditEvent(tx, {
        organizationId: membership.organizationId,
        propertyId: null,
        actorUserId: user.id,
        actorSystem: null,
        action: AuditAction.USER_SIGNED_IN,
        entityType: 'User',
        entityId: user.id,
        metadata: { role: membership.role },
        correlationId,
        occurredAt: new Date(),
      });
    });

    return session;
  }

  private async recordSignInFailure(
    organizationId: string,
    userId: string,
    correlationId: string,
  ): Promise<void> {
    await recordAuditEvent(this.prisma.client, {
      organizationId,
      propertyId: null,
      actorUserId: userId,
      actorSystem: null,
      action: AuditAction.SIGN_IN_FAILED,
      entityType: 'User',
      entityId: userId,
      // Deliberately no password, no hash, no supplied value.
      metadata: { reason: 'invalid_credentials' },
      correlationId,
      occurredAt: new Date(),
    }).catch((error: unknown) => {
      this.logger.warn({ err: error }, 'Could not record a sign-in failure audit event');
    });
  }

  async signOut(
    sessionId: string,
    access: AccessContext,
    res: Response,
    correlationId: string,
  ): Promise<void> {
    await this.sessions.revoke(sessionId, res);
    await recordAuditEvent(this.prisma.client, {
      organizationId: access.organizationId,
      propertyId: null,
      actorUserId: access.userId,
      actorSystem: null,
      action: AuditAction.USER_SIGNED_OUT,
      entityType: 'User',
      entityId: access.userId,
      metadata: {},
      correlationId,
      occurredAt: new Date(),
    });
  }

  /** Assembles the viewer payload, including the action list the UI uses. */
  async viewer(access: AccessContext): Promise<ViewerPayload> {
    const [user, organization] = await Promise.all([
      this.prisma.client.user.findUniqueOrThrow({
        where: { id: access.userId },
        select: { id: true, email: true, displayName: true },
      }),
      this.prisma.client.organization.findUniqueOrThrow({
        where: { id: access.organizationId },
        select: { id: true, slug: true, name: true, currency: true },
      }),
    ]);

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      organization,
      role: access.role,
      // Null means "every property in the organization", which is different
      // from an empty list meaning "none".
      assignedPropertyIds: isOrganizationScoped(access.role)
        ? null
        : [...access.assignedPropertyIds].sort(),
      // Advisory only: it drives which buttons render. Every action is checked
      // again on the server when it is actually invoked.
      permissions: [...allowedActions(access.role)],
    };
  }

  /**
   * Members of the viewer's organization, with their property assignments.
   *
   * Scoped to `access.organizationId`, so this cannot enumerate people in
   * another organization however it is called.
   */
  async listMembers(access: AccessContext): Promise<MemberPayload[]> {
    const rows = await this.prisma.client.membership.findMany({
      where: { organizationId: access.organizationId },
      select: {
        id: true,
        role: true,
        status: true,
        user: { select: { id: true, email: true, displayName: true } },
        assignments: {
          select: { property: { select: { id: true, code: true, name: true } } },
        },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      userId: row.user.id,
      email: row.user.email,
      displayName: row.user.displayName,
      role: row.role,
      status: row.status,
      assignedProperties: row.assignments.map((assignment) => assignment.property),
    }));
  }
}
