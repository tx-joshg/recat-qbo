import type { AgentToolDefinition, AgentToolResult } from './tools.js';

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type AgentConversationItem =
  | {
      kind: 'tool_result';
      callId: string;
      name: string;
      result: AgentToolResult;
    }
  | {
      kind: 'correction';
      message: string;
    };

export interface AgentModelInput {
  systemPrompt: string;
  transaction: Record<string, unknown>;
  tools: AgentToolDefinition[];
  history: AgentConversationItem[];
  maxContextBytes?: number;
}

export type AgentModelTurn =
  | { kind: 'tool_calls'; calls: AgentToolCall[] }
  | { kind: 'decision'; value: unknown };

export interface AgentModel {
  readonly provider: string;
  readonly model: string;
  nextTurn(input: AgentModelInput, signal: AbortSignal): Promise<AgentModelTurn>;
}
