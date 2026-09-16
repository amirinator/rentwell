/**
 * The assistant's tools.
 *
 * Every tool here is a read. There is no write tool, and adding one would be a
 * deliberate architectural change rather than a configuration flag: the
 * assistant cannot approve an allocation, post an entry, change a lease,
 * resolve an exception, or move a period, because no code path exists for it to
 * do so.
 *
 * Each tool also re-applies the requesting user's authorization. The assistant
 * runs *as* that user, never with elevated access, so it can only see what they
 * could have opened themselves. A tool call naming a record in another
 * organization returns "not found", exactly as the API would.
 *
 * Record ids returned by tools are collected by the runner, and the output
 * validator drops any citation that does not appear in that set.
 */

import { z } from 'zod';
import {
  DomainError,
  assertCan,
  formatCents,
  hasPropertyAccess,
  sanitizeUntrustedText,
  type AccessContext,
} from '@rentwell/domain';
import { centsFromDb, type PrismaClient } from '@rentwell/database';
import type { AssistantCitation } from './output';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodTypeAny;
  readonly jsonSchema: Record<string, unknown>;
}

export interface ToolResult {
  /** Rendered for the model. Untrusted text inside is already sanitized. */
  readonly content: string;
  /**
   * Records this call actually returned, each with its real type.
   *
   * The runner uses these two ways: the ids form the set a citation must appear
   * in, and the typed references are what a citation falls back to. Carrying
   * the type here rather than guessing later is what stops a charge id being
   * presented to an accountant as a payment.
   */
  readonly records: AssistantCitation[];
  /** One-line summary stored on the run for the audit trail. */
  readonly summary: string;
}

function ref(
  recordType: AssistantCitation['recordType'],
  recordId: string,
  label: string,
): AssistantCitation {
  return { recordType, recordId, label: label.slice(0, 200) };
}

export interface ToolContext {
  readonly prisma: PrismaClient;
  readonly access: AccessContext;
  readonly exceptionId: string;
}

const TOOL_SCHEMAS = {
  get_exception: z.object({}),
  get_transaction: z.object({ transactionId: z.string().min(1).max(64) }),
  list_candidate_charges: z.object({
    tenantId: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  get_tenant_payment_history: z.object({
    tenantId: z.string().min(1).max(64),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  list_allocations: z.object({ transactionId: z.string().min(1).max(64) }),
  get_match_evidence: z.object({ transactionId: z.string().min(1).max(64) }),
} as const;

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'get_exception',
    description:
      'Returns the exception under investigation: its category, severity, unreconciled amount and the payment it concerns.',
    schema: TOOL_SCHEMAS.get_exception,
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_transaction',
    description:
      'Returns one bank transaction: amount, dates, reference, description, status and how much of it is allocated.',
    schema: TOOL_SCHEMAS.get_transaction,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['transactionId'],
      properties: { transactionId: { type: 'string' } },
    },
  },
  {
    name: 'list_candidate_charges',
    description:
      'Lists open charges in the same property that the payment could settle, oldest first. Optionally narrowed to one tenant.',
    schema: TOOL_SCHEMAS.list_candidate_charges,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tenantId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
    },
  },
  {
    name: 'get_tenant_payment_history',
    description:
      'Returns a tenant recent payments and how each was allocated, which is how a habitual payment pattern becomes visible.',
    schema: TOOL_SCHEMAS.get_tenant_payment_history,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tenantId'],
      properties: {
        tenantId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
    },
  },
  {
    name: 'list_allocations',
    description: 'Lists the allocations drawn from one payment, including reversed ones.',
    schema: TOOL_SCHEMAS.list_allocations,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['transactionId'],
      properties: { transactionId: { type: 'string' } },
    },
  },
  {
    name: 'get_match_evidence',
    description:
      'Returns the reconciliation engine stored suggestions for a payment, with the evidence and score components behind each one.',
    schema: TOOL_SCHEMAS.get_match_evidence,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['transactionId'],
      properties: { transactionId: { type: 'string' } },
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

export function isKnownTool(name: string): boolean {
  return TOOLS_BY_NAME.has(name);
}

/**
 * Executes one tool call under the requesting user's authority.
 *
 * Throws ASSISTANT_TOOL_DENIED for an unknown tool or malformed arguments, and
 * the ordinary NOT_FOUND / PROPERTY_NOT_ASSIGNED for a record the user may not
 * see. The caller records every attempt, allowed or denied.
 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  rawArguments: unknown,
): Promise<ToolResult> {
  const definition = TOOLS_BY_NAME.get(name);
  if (!definition) {
    throw new DomainError(
      'ASSISTANT_TOOL_DENIED',
      `No such tool: ${sanitizeUntrustedText(name, 60)}`,
      {
        details: { tool: name },
      },
    );
  }

  // Read permission is checked per call, not once at the start: a membership
  // suspended mid-run stops the next tool call.
  assertCan(ctx.access, 'exception:read');

  const parsed = definition.schema.safeParse(rawArguments ?? {});
  if (!parsed.success) {
    throw new DomainError('ASSISTANT_TOOL_DENIED', `Invalid arguments for ${name}`, {
      details: {
        tool: name,
        issues: parsed.error.issues.map((issue) => issue.message).slice(0, 5),
      },
    });
  }

  switch (name) {
    case 'get_exception':
      return getException(ctx);
    case 'get_transaction':
      return getTransaction(ctx, parsed.data as { transactionId: string });
    case 'list_candidate_charges':
      return listCandidateCharges(ctx, parsed.data as { tenantId?: string; limit?: number });
    case 'get_tenant_payment_history':
      return getTenantPaymentHistory(ctx, parsed.data as { tenantId: string; limit?: number });
    case 'list_allocations':
      return listAllocations(ctx, parsed.data as { transactionId: string });
    case 'get_match_evidence':
      return getMatchEvidence(ctx, parsed.data as { transactionId: string });
    default:
      throw new DomainError('ASSISTANT_TOOL_DENIED', `Unhandled tool: ${name}`);
  }
}

// --------------------------------------------------------------------------
// Implementations
// --------------------------------------------------------------------------

async function getException(ctx: ToolContext): Promise<ToolResult> {
  const exception = await ctx.prisma.reconciliationException.findFirst({
    where: { id: ctx.exceptionId, organizationId: ctx.access.organizationId },
    include: {
      transaction: { select: { id: true, amountCents: true, currency: true, reference: true } },
      tenant: { select: { id: true, displayName: true } },
    },
  });
  if (!exception) throw new DomainError('NOT_FOUND', 'Exception not found');
  assertProperty(ctx, exception.propertyId);

  const records: AssistantCitation[] = [
    ref(
      'ReconciliationException',
      exception.id,
      `${exception.category} exception under investigation`,
    ),
  ];
  if (exception.transaction) {
    records.push(
      ref('BankTransaction', exception.transaction.id, 'Payment this exception concerns'),
    );
  }
  if (exception.tenant) {
    records.push(ref('Tenant', exception.tenant.id, exception.tenant.displayName));
  }

  const lines = [
    `Exception ${exception.id}`,
    `Category: ${exception.category}`,
    `Severity: ${exception.severity}`,
    `Status: ${exception.status}`,
    `Blocks close: ${exception.isBlocking ? 'yes' : 'no'}`,
    `Period: ${exception.period}`,
    `Unreconciled amount: ${formatCents(centsFromDb(exception.openAmountCents), exception.currency)} ${exception.currency}`,
    `Summary: ${sanitizeUntrustedText(exception.summary, 400)}`,
    exception.transaction ? `Payment: ${exception.transaction.id}` : 'Payment: none linked',
    exception.tenant
      ? `Tenant: ${exception.tenant.displayName} (${exception.tenant.id})`
      : 'Tenant: not identified',
  ];

  return {
    content: lines.join('\n'),
    records,
    summary: `exception ${exception.category}/${exception.severity}`,
  };
}

async function getTransaction(
  ctx: ToolContext,
  args: { transactionId: string },
): Promise<ToolResult> {
  const transaction = await ctx.prisma.bankTransaction.findFirst({
    where: { id: args.transactionId, organizationId: ctx.access.organizationId },
    include: { bankAccount: { select: { label: true, maskedNumber: true } } },
  });
  if (!transaction) throw new DomainError('NOT_FOUND', 'Payment not found');
  assertProperty(ctx, transaction.propertyId);

  const currency = transaction.currency.trim();
  const amount = centsFromDb(transaction.amountCents);
  const allocated = centsFromDb(transaction.allocatedCents);

  const content = [
    `Payment ${transaction.id}`,
    `Amount: ${formatCents(amount, currency)} ${currency}`,
    `Allocated: ${formatCents(allocated, currency)} ${currency}`,
    `Unapplied: ${formatCents(amount - allocated, currency)} ${currency}`,
    `Status: ${transaction.status}`,
    `Posted date: ${transaction.postedDate.toISOString().slice(0, 10)}`,
    `Period: ${transaction.period}`,
    `Source: ${transaction.source}`,
    `Bank account: ${transaction.bankAccount.label} (...${transaction.bankAccount.maskedNumber})`,
    `Reference: ${transaction.reference ? sanitizeUntrustedText(transaction.reference, 100) : '(none)'}`,
    // The description is written by whoever sent the money. It is presented as
    // a quoted claim, never as a fact about the payment.
    `Description as supplied by the payer (untrusted, not verified): "${sanitizeUntrustedText(transaction.description, 300)}"`,
  ].join('\n');

  return {
    content,
    records: [
      ref(
        'BankTransaction',
        transaction.id,
        `Payment of ${formatCents(amount, currency)} ${currency} on ${transaction.postedDate.toISOString().slice(0, 10)}`,
      ),
    ],
    summary: `payment ${formatCents(amount, currency)} ${currency}, ${transaction.status}`,
  };
}

async function listCandidateCharges(
  ctx: ToolContext,
  args: { tenantId?: string; limit?: number },
): Promise<ToolResult> {
  const exception = await ctx.prisma.reconciliationException.findFirst({
    where: { id: ctx.exceptionId, organizationId: ctx.access.organizationId },
    select: { propertyId: true, currency: true },
  });
  if (!exception) throw new DomainError('NOT_FOUND', 'Exception not found');
  assertProperty(ctx, exception.propertyId);

  const charges = await ctx.prisma.charge.findMany({
    where: {
      propertyId: exception.propertyId,
      organizationId: ctx.access.organizationId,
      status: { in: ['POSTED', 'SETTLED'] },
      ...(args.tenantId ? { tenantId: args.tenantId } : {}),
    },
    include: { tenant: { select: { displayName: true } } },
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    take: args.limit ?? 15,
  });

  const open = charges.filter(
    (charge) =>
      centsFromDb(charge.amountCents) -
        centsFromDb(charge.allocatedCents) -
        centsFromDb(charge.creditedCents) >
      0,
  );

  if (open.length === 0) {
    return {
      content: 'No open charges match. Every charge in this property is settled or voided.',
      records: [],
      summary: 'no open charges',
    };
  }

  const rows = open.map((charge) => {
    const currency = charge.currency.trim();
    const openBalance =
      centsFromDb(charge.amountCents) -
      centsFromDb(charge.allocatedCents) -
      centsFromDb(charge.creditedCents);
    return [
      `- ${charge.id}`,
      `  tenant: ${charge.tenant.displayName}`,
      `  type: ${charge.type}`,
      `  due: ${charge.dueDate.toISOString().slice(0, 10)}`,
      `  amount: ${formatCents(centsFromDb(charge.amountCents), currency)} ${currency}`,
      `  open balance: ${formatCents(openBalance, currency)} ${currency}`,
    ].join('\n');
  });

  return {
    content: `${open.length} open charge(s):\n${rows.join('\n')}`,
    records: open.map((charge) =>
      ref(
        'Charge',
        charge.id,
        `${charge.type} for ${charge.tenant.displayName} due ${charge.dueDate.toISOString().slice(0, 10)}`,
      ),
    ),
    summary: `${open.length} open charges`,
  };
}

async function getTenantPaymentHistory(
  ctx: ToolContext,
  args: { tenantId: string; limit?: number },
): Promise<ToolResult> {
  const tenant = await ctx.prisma.tenant.findFirst({
    where: { id: args.tenantId, organizationId: ctx.access.organizationId },
    select: { id: true, displayName: true, paymentReference: true },
  });
  if (!tenant) throw new DomainError('NOT_FOUND', 'Tenant not found');

  const allocations = await ctx.prisma.allocation.findMany({
    where: {
      organizationId: ctx.access.organizationId,
      charge: { tenantId: tenant.id },
    },
    include: {
      transaction: {
        select: { id: true, amountCents: true, currency: true, postedDate: true, reference: true },
      },
    },
    orderBy: { approvedAt: 'desc' },
    take: args.limit ?? 10,
  });

  const visible = allocations.filter((allocation) =>
    hasPropertyAccess(ctx.access, allocation.propertyId),
  );

  const records: AssistantCitation[] = [
    ref('Tenant', tenant.id, tenant.displayName),
    ...visible.map((allocation) =>
      ref(
        'BankTransaction',
        allocation.transaction.id,
        `Earlier payment on ${allocation.transaction.postedDate.toISOString().slice(0, 10)}`,
      ),
    ),
  ];

  const rows = visible.map((allocation) => {
    const currency = allocation.currency.trim();
    return [
      `- payment ${allocation.transaction.id} on ${allocation.transaction.postedDate.toISOString().slice(0, 10)}`,
      `  payment amount: ${formatCents(centsFromDb(allocation.transaction.amountCents), currency)} ${currency}`,
      `  allocated here: ${formatCents(centsFromDb(allocation.amountCents), currency)} ${currency}`,
      `  allocation status: ${allocation.status}`,
      `  reference on the payment: ${allocation.transaction.reference ? sanitizeUntrustedText(allocation.transaction.reference, 60) : '(none)'}`,
    ].join('\n');
  });

  const header = [
    `Tenant ${tenant.displayName} (${tenant.id})`,
    `Invoice reference: ${tenant.paymentReference ?? '(none on file)'}`,
    '',
  ].join('\n');

  return {
    content:
      visible.length === 0
        ? `${header}No allocated payments on record for this tenant.`
        : `${header}${visible.length} recent allocation(s):\n${rows.join('\n')}`,
    records,
    summary: `${visible.length} historic allocations`,
  };
}

async function listAllocations(
  ctx: ToolContext,
  args: { transactionId: string },
): Promise<ToolResult> {
  const transaction = await ctx.prisma.bankTransaction.findFirst({
    where: { id: args.transactionId, organizationId: ctx.access.organizationId },
    select: { id: true, propertyId: true, currency: true },
  });
  if (!transaction) throw new DomainError('NOT_FOUND', 'Payment not found');
  assertProperty(ctx, transaction.propertyId);

  const allocations = await ctx.prisma.allocation.findMany({
    where: { transactionId: transaction.id },
    include: { reversal: { select: { reason: true, createdAt: true } } },
    orderBy: { approvedAt: 'asc' },
  });

  if (allocations.length === 0) {
    return {
      content: 'This payment has no allocations, active or reversed.',
      records: [ref('BankTransaction', transaction.id, 'Payment with no allocations')],
      summary: 'no allocations',
    };
  }

  const currency = transaction.currency.trim();
  const rows = allocations.map((allocation) =>
    [
      `- ${allocation.id} -> charge ${allocation.chargeId}`,
      `  amount: ${formatCents(centsFromDb(allocation.amountCents), currency)} ${currency}`,
      `  status: ${allocation.status}`,
      `  approved: ${allocation.approvedAt.toISOString()}`,
      allocation.reversal
        ? `  reversed: ${allocation.reversal.createdAt.toISOString()} because ${sanitizeUntrustedText(allocation.reversal.reason, 200)}`
        : '  reversed: no',
    ].join('\n'),
  );

  return {
    content: `${allocations.length} allocation(s):\n${rows.join('\n')}`,
    records: [
      ref('BankTransaction', transaction.id, 'Payment these allocations draw on'),
      ...allocations.map((allocation) =>
        ref(
          'Allocation',
          allocation.id,
          `${allocation.status} allocation to charge ${allocation.chargeId}`,
        ),
      ),
    ],
    summary: `${allocations.length} allocations`,
  };
}

async function getMatchEvidence(
  ctx: ToolContext,
  args: { transactionId: string },
): Promise<ToolResult> {
  const transaction = await ctx.prisma.bankTransaction.findFirst({
    where: { id: args.transactionId, organizationId: ctx.access.organizationId },
    select: { id: true, propertyId: true },
  });
  if (!transaction) throw new DomainError('NOT_FOUND', 'Payment not found');
  assertProperty(ctx, transaction.propertyId);

  const suggestions = await ctx.prisma.matchSuggestion.findMany({
    where: { transactionId: transaction.id },
    orderBy: [{ score: 'desc' }, { id: 'asc' }],
    take: 5,
  });

  if (suggestions.length === 0) {
    return {
      content:
        'The reconciliation engine produced no suggestions for this payment. That usually means no tenant could be identified from the reference or description, or no open charge matched.',
      records: [ref('BankTransaction', transaction.id, 'Payment with no stored suggestions')],
      summary: 'no suggestions',
    };
  }

  const rows = suggestions.map((suggestion) => {
    const evidence = Array.isArray(suggestion.evidence) ? suggestion.evidence : [];
    const labels = evidence
      .map((item) => {
        const entry = item as { label?: unknown };
        return typeof entry.label === 'string'
          ? `    * ${sanitizeUntrustedText(entry.label, 200)}`
          : null;
      })
      .filter((line): line is string => line !== null);

    return [
      `- ${suggestion.strategy} (status ${suggestion.status})`,
      // Stated as a ranking, so the model does not describe it as a confidence.
      `  ranking score: ${String(suggestion.score)} out of 100 (a ranking used to order candidates, not a probability)`,
      `  rule version: ${suggestion.ruleVersion}`,
      '  evidence:',
      ...(labels.length > 0 ? labels : ['    * (none recorded)']),
    ].join('\n');
  });

  return {
    content: `${suggestions.length} stored suggestion(s):\n${rows.join('\n')}`,
    records: [ref('BankTransaction', transaction.id, 'Payment these suggestions concern')],
    summary: `${suggestions.length} suggestions`,
  };
}

function assertProperty(ctx: ToolContext, propertyId: string): void {
  if (!hasPropertyAccess(ctx.access, propertyId)) {
    throw new DomainError('PROPERTY_NOT_ASSIGNED', 'You are not assigned to that property', {
      details: { propertyId },
    });
  }
}
