/**
 * Assistant provider abstraction.
 *
 * Two implementations ship:
 *
 *  - **mock** (the default). Deterministic: the same exception always produces
 *    the same analysis, built from the records the tools actually returned. It
 *    needs no credentials, so the demo, the integration tests and CI all run
 *    the real assistant code path end to end.
 *  - **anthropic**. Calls the Claude Messages API with the same tools and the
 *    same output schema.
 *
 * Everything above this interface — budgets, tool authorization, output
 * validation, grounding, run recording — is provider-independent, so switching
 * providers cannot weaken any of it.
 */

import { DomainError } from '@rentwell/domain';
import { ANALYSIS_JSON_SCHEMA, parseAnalysis, type AssistantAnalysis } from './output';
import { TOOL_DEFINITIONS } from './tools';

export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ProviderTurn {
  /** Tool calls the model wants executed before it can answer. */
  readonly toolCalls: readonly ProviderToolCall[];
  /** The final structured answer, present only when there are no tool calls. */
  readonly analysis: AssistantAnalysis | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface ProviderMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

export interface AssistantProvider {
  readonly name: string;
  readonly model: string;
  /** Advances the conversation by one turn. */
  next(messages: readonly ProviderMessage[], systemPrompt: string): Promise<ProviderTurn>;
}

// --------------------------------------------------------------------------
// Mock
// --------------------------------------------------------------------------

/**
 * Deterministic provider used by default.
 *
 * It follows a fixed investigation plan — read the exception, read the payment,
 * read the engine's evidence, list candidate charges — then writes an analysis
 * from what those calls returned. It never asserts anything the tool output
 * does not contain, which is exactly the property the grounding evaluation
 * tests for.
 */
export class MockAssistantProvider implements AssistantProvider {
  readonly name = 'mock';
  readonly model: string;

  constructor(model = 'mock-deterministic-1') {
    this.model = model;
  }

  async next(messages: readonly ProviderMessage[], _systemPrompt: string): Promise<ProviderTurn> {
    const toolResults = messages.filter((message) => message.role === 'tool');
    const called = new Set(toolResults.map((message) => message.toolName));

    const plan = [
      'get_exception',
      'get_transaction',
      'get_match_evidence',
      'list_candidate_charges',
    ];

    for (const toolName of plan) {
      if (called.has(toolName)) continue;

      const args = this.argumentsFor(toolName, toolResults);
      // A step whose input is not available yet is skipped rather than called
      // with a guessed id.
      if (args === null) continue;

      return {
        toolCalls: [{ id: `mock-${toolName}`, name: toolName, arguments: args }],
        analysis: null,
      };
    }

    return { toolCalls: [], analysis: this.compose(toolResults) };
  }

  /** Pulls a transaction id out of earlier tool output rather than inventing one. */
  private argumentsFor(toolName: string, toolResults: readonly ProviderMessage[]): unknown | null {
    if (toolName === 'get_exception' || toolName === 'list_candidate_charges') return {};

    const transactionId = this.findTransactionId(toolResults);
    if (transactionId === null) return null;
    return { transactionId };
  }

  private findTransactionId(toolResults: readonly ProviderMessage[]): string | null {
    for (const message of toolResults) {
      const match = /^Payment:\s*([A-Za-z0-9-]{6,})$/m.exec(message.content);
      if (match?.[1]) return match[1];
      const direct = /^Payment\s+([A-Za-z0-9-]{6,})$/m.exec(message.content);
      if (direct?.[1]) return direct[1];
    }
    return null;
  }

  /** Builds the analysis strictly from what the tools returned. */
  private compose(toolResults: readonly ProviderMessage[]): AssistantAnalysis {
    const text = toolResults.map((message) => message.content).join('\n');

    const category = /^Category:\s*(\w+)$/m.exec(text)?.[1] ?? 'UNKNOWN';
    const unreconciled = /^Unreconciled amount:\s*(.+)$/m.exec(text)?.[1] ?? 'an unknown amount';
    const paymentAmount = /^Amount:\s*(.+)$/m.exec(text)?.[1] ?? null;
    const status = /^Status:\s*(\w+)$/m.exec(text)?.[1] ?? null;
    const noSuggestions = text.includes('produced no suggestions');
    const openChargeCount = /(\d+) open charge\(s\)/.exec(text)?.[1] ?? null;

    const summaryParts = [
      `This exception is categorised ${category} with ${unreconciled} unreconciled.`,
    ];
    if (paymentAmount) summaryParts.push(`The payment is ${paymentAmount}.`);
    if (status) summaryParts.push(`Its status is ${status}.`);
    summaryParts.push(
      noSuggestions
        ? 'The reconciliation engine produced no candidate match.'
        : 'The reconciliation engine produced at least one candidate match; its evidence is listed below.',
    );

    const explanations: string[] = [];
    if (category === 'MISSING_REFERENCE') {
      explanations.push(
        'The payer omitted the invoice reference, so no tenant could be identified automatically.',
      );
      explanations.push(
        'The payment may belong to a tenant whose reference on file differs from the one they use.',
      );
    }
    if (category === 'AMBIGUOUS_MATCH') {
      explanations.push(
        'Several open charges match the payment equally well, so the engine declined to choose.',
      );
    }
    if (category === 'OVERPAYMENT') {
      explanations.push(
        'The tenant paid more than they currently owe, possibly in advance of a future charge.',
      );
    }
    if (category === 'UNDERPAYMENT') {
      explanations.push(
        'The tenant paid part of what they owe; the remainder is still outstanding.',
      );
    }
    if (category === 'SUSPECTED_DUPLICATE') {
      explanations.push(
        'An earlier payment with the same amount, date and reference already exists on this account.',
      );
    }
    if (category === 'REVERSED_PAYMENT') {
      explanations.push(
        'The provider returned this payment, so any allocation it settled has been unwound.',
      );
    }
    if (explanations.length === 0) {
      explanations.push('The records retrieved do not indicate a single clear cause.');
    }

    const nextSteps = [
      'Compare the payment reference and description with the tenant references on the candidate charges.',
      openChargeCount
        ? `Review the ${openChargeCount} open charge(s) listed above and allocate against the ones the tenant intended to pay.`
        : 'Confirm whether any open charge remains that this payment could settle.',
      'If the payment cannot be matched, classify the remainder as unapplied cash with a stated reason.',
    ];

    const missing = [
      'Whether the tenant has sent remittance advice naming the invoices they intended to pay.',
      'Whether the payer reference on file is current.',
    ];

    return {
      summary: summaryParts.join(' '),
      // Citations are filled in by the runner from the ids the tools returned,
      // so the mock cannot fabricate one.
      supportingRecords: [],
      possibleExplanations: explanations.slice(0, 10),
      recommendedNextSteps: nextSteps.slice(0, 10),
      missingInformation: missing.slice(0, 10),
    };
  }
}

// --------------------------------------------------------------------------
// Anthropic
// --------------------------------------------------------------------------

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

/**
 * Calls the Claude Messages API.
 *
 * The SDK is imported lazily so a deployment running in mock mode does not load
 * it, and a missing optional dependency degrades to a clear
 * ASSISTANT_UNAVAILABLE rather than a crash at startup.
 */
export class AnthropicAssistantProvider implements AssistantProvider {
  readonly name = 'anthropic';
  readonly model: string;

  private client: unknown = null;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.model = options.model;
  }

  private async getClient(): Promise<AnthropicLikeClient> {
    if (this.client !== null) return this.client as AnthropicLikeClient;
    try {
      const module = await import('@anthropic-ai/sdk');
      const Anthropic = (module as { default: new (config: unknown) => unknown }).default;
      this.client = new Anthropic({
        apiKey: this.options.apiKey,
        timeout: this.options.timeoutMs,
        maxRetries: 2,
      });
      return this.client as AnthropicLikeClient;
    } catch (error) {
      throw new DomainError('ASSISTANT_UNAVAILABLE', 'The Anthropic SDK is not available', {
        cause: error,
      });
    }
  }

  async next(messages: readonly ProviderMessage[], systemPrompt: string): Promise<ProviderTurn> {
    const client = await this.getClient();

    const tools = [
      ...TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.jsonSchema,
      })),
      // The model returns its answer by calling this tool, which is how the
      // response is forced into the schema instead of being parsed out of prose.
      {
        name: 'submit_analysis',
        description: 'Submit the final structured analysis. Call this exactly once, when finished.',
        input_schema: ANALYSIS_JSON_SCHEMA as unknown as Record<string, unknown>,
      },
    ];

    let response: AnthropicResponse;
    try {
      response = await client.messages.create({
        model: this.model,
        max_tokens: this.options.maxOutputTokens,
        system: systemPrompt,
        tools,
        messages: toAnthropicMessages(messages),
      });
    } catch (error) {
      throw new DomainError(
        'ASSISTANT_UNAVAILABLE',
        'The assistant provider could not be reached',
        {
          retryable: true,
          cause: error,
        },
      );
    }

    const toolCalls: ProviderToolCall[] = [];
    let analysis: AssistantAnalysis | null = null;

    for (const block of response.content ?? []) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'submit_analysis') {
        analysis = parseAnalysis(block.input);
        continue;
      }
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
    }

    return {
      toolCalls,
      analysis,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    };
  }
}

interface AnthropicResponse {
  content?: { type: string; id: string; name: string; input: unknown }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicLikeClient {
  messages: { create(body: Record<string, unknown>): Promise<AnthropicResponse> };
}

function toAnthropicMessages(messages: readonly ProviderMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId ?? 'unknown',
            content: message.content,
          },
        ],
      };
    }
    return { role: message.role, content: message.content };
  });
}
