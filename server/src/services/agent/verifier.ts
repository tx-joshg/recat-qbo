import { z } from 'zod';
import { AGENT_DECISION_VALUE_JSON_SCHEMA } from './codexModel.js';
import type { AgentToolContext } from './context.js';
import {
  agentDecisionSchema,
  type AgentDecision,
  type DecisionValidationReport,
} from './decision.js';
import { AgentError, asAgentError } from './errors.js';
import type { AgentModel, AgentModelInput } from './model.js';

export const AGENT_VERIFIER_PROMPT_VERSION = 'recat-verifier-v1';

export const verifierResultSchema = z
  .object({
    verdict: z.enum(['agree', 'disagree', 'correction']),
    rationale: z.string().trim().min(1).max(2_000),
    correction: agentDecisionSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.verdict === 'correction' && value.correction === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correction'],
        message: 'A correction verdict requires a corrected decision.',
      });
    }
    if (value.verdict !== 'correction' && value.correction !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correction'],
        message: 'Only a correction verdict may include a corrected decision.',
      });
    }
  });

export type VerifierResult = z.infer<typeof verifierResultSchema>;

export const VERIFIER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'rationale', 'correction'],
  properties: {
    verdict: { type: 'string', enum: ['agree', 'disagree', 'correction'] },
    rationale: { type: 'string', minLength: 1, maxLength: 2_000 },
    correction: {
      anyOf: [
        AGENT_DECISION_VALUE_JSON_SCHEMA,
        { type: 'null' },
      ],
    },
  },
};

function verifierPrompt(): string {
  return [
    'Independently verify one proposed QuickBooks Purchase decision.',
    'Use only the sanitized transaction context and proposed structured decision.',
    'Agree only when the accounting category, gross allocation, tax mode, and TaxCode are supported.',
    'Return disagree when evidence is insufficient, or correction with a complete corrected decision.',
    'Do not rely on hidden reasoning from the primary agent.',
  ].join(' ');
}

export async function runVerifier(
  model: AgentModel,
  context: AgentToolContext,
  proposed: AgentDecision,
  validation: DecisionValidationReport,
  signal: AbortSignal,
): Promise<VerifierResult> {
  const input: AgentModelInput = {
    systemPrompt: verifierPrompt(),
    transaction: {
      schemaVersion: 'recat-verifier-input-v1',
      transaction: context.transaction,
      originalLines: context.originalLines,
      proposed,
      resolvedDecision: {
        resolvedLines: validation.resolvedLines ?? [],
        transferCounterpartId: validation.transferCounterpartId ?? null,
      },
    },
    tools: [],
    history: [],
  };
  try {
    const turn = await model.nextTurn(input, signal);
    if (turn.kind !== 'decision') {
      throw new AgentError(
        'AGENT_MALFORMED_OUTPUT',
        'The verifier attempted a tool call.',
        false,
      );
    }
    const value =
      turn.value &&
      typeof turn.value === 'object' &&
      (turn.value as Record<string, unknown>).correction === null
        ? Object.fromEntries(
            Object.entries(turn.value as Record<string, unknown>).filter(
              ([key]) => key !== 'correction',
            ),
          )
        : turn.value;
    return verifierResultSchema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new AgentError(
        'AGENT_MALFORMED_OUTPUT',
        'The verifier returned invalid structured evidence.',
        false,
      );
    }
    throw asAgentError(error);
  }
}
