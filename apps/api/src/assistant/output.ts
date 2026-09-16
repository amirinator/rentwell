/**
 * The assistant's output contract.
 *
 * The model must return exactly this structure. It is validated before anything
 * is stored or shown, so a malformed or creatively-shaped response becomes a
 * failed run with a clear reason rather than a half-rendered panel.
 *
 * The five sections are fixed by the specification:
 *
 *     Summary
 *     Supporting records
 *     Possible explanations
 *     Recommended next steps
 *     Missing information
 *
 * `supportingRecords` is the part that makes the rest checkable: every citation
 * names a record type and id the requesting user is authorized to open, and the
 * service verifies that each cited id really was returned by a tool call during
 * the run. A model cannot cite a record it never looked at.
 */

import { z } from 'zod';
import { DomainError } from '@rentwell/domain';

export const CITED_RECORD_TYPES = [
  'BankTransaction',
  'Charge',
  'Allocation',
  'Lease',
  'Tenant',
  'ReconciliationException',
  'JournalEntry',
  'CreditAdjustment',
] as const;

export const citationSchema = z.object({
  recordType: z.enum(CITED_RECORD_TYPES),
  recordId: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
});

export const assistantAnalysisSchema = z.object({
  summary: z.string().min(1).max(2000),
  supportingRecords: z.array(citationSchema).max(25),
  possibleExplanations: z.array(z.string().min(1).max(500)).max(10),
  recommendedNextSteps: z.array(z.string().min(1).max(500)).max(10),
  missingInformation: z.array(z.string().min(1).max(500)).max(10),
});

export type AssistantAnalysis = z.infer<typeof assistantAnalysisSchema>;
export type AssistantCitation = z.infer<typeof citationSchema>;

/** JSON Schema handed to the provider so it returns the right shape. */
export const ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'supportingRecords',
    'possibleExplanations',
    'recommendedNextSteps',
    'missingInformation',
  ],
  properties: {
    summary: {
      type: 'string',
      description:
        'What the discrepancy is, in two or three sentences, stated as fact only where a retrieved record supports it.',
    },
    supportingRecords: {
      type: 'array',
      maxItems: 25,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['recordType', 'recordId', 'label'],
        properties: {
          recordType: { type: 'string', enum: [...CITED_RECORD_TYPES] },
          recordId: { type: 'string' },
          label: { type: 'string', description: 'How this record supports the summary.' },
        },
      },
    },
    possibleExplanations: { type: 'array', maxItems: 10, items: { type: 'string' } },
    recommendedNextSteps: { type: 'array', maxItems: 10, items: { type: 'string' } },
    missingInformation: {
      type: 'array',
      maxItems: 10,
      items: { type: 'string' },
      description: 'What could not be determined from the records available.',
    },
  },
} as const;

/**
 * Parses and validates a model response.
 *
 * Accepts a JSON string or an already-parsed object. Anything that does not fit
 * the schema raises ASSISTANT_OUTPUT_INVALID with the field paths that failed,
 * which is what the run record stores.
 */
export function parseAnalysis(raw: unknown): AssistantAnalysis {
  let candidate: unknown = raw;

  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(extractJsonObject(raw));
    } catch {
      throw new DomainError('ASSISTANT_OUTPUT_INVALID', 'The assistant did not return valid JSON', {
        details: { preview: raw.slice(0, 200) },
      });
    }
  }

  const result = assistantAnalysisSchema.safeParse(candidate);
  if (!result.success) {
    throw new DomainError(
      'ASSISTANT_OUTPUT_INVALID',
      'The assistant returned an unexpected structure',
      {
        details: {
          issues: result.error.issues.slice(0, 10).map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      },
    );
  }

  return result.data;
}

/**
 * Pulls the first balanced JSON object out of a response that may be wrapped in
 * prose or a code fence. Tolerating that is cheaper than failing a run over
 * formatting, and the schema check still does the real work.
 */
function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

/**
 * Drops citations naming records the run never actually retrieved.
 *
 * This is the grounding check. A model that invents a plausible charge id gets
 * that citation removed and a note added to `missingInformation`, so the
 * accountant sees an honest gap instead of a confident link to nothing.
 */
export function enforceGrounding(
  analysis: AssistantAnalysis,
  retrievedIds: ReadonlySet<string>,
): { analysis: AssistantAnalysis; droppedCitations: AssistantCitation[] } {
  const kept: AssistantCitation[] = [];
  const dropped: AssistantCitation[] = [];

  for (const citation of analysis.supportingRecords) {
    if (retrievedIds.has(citation.recordId)) kept.push(citation);
    else dropped.push(citation);
  }

  if (dropped.length === 0) return { analysis, droppedCitations: [] };

  return {
    analysis: {
      ...analysis,
      supportingRecords: kept,
      missingInformation: [
        ...analysis.missingInformation,
        `${dropped.length} cited record reference(s) could not be verified against the records retrieved during this analysis and were removed.`,
      ].slice(0, 10),
    },
    droppedCitations: dropped,
  };
}
