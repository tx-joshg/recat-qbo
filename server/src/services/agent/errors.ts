export type AgentErrorCode =
  | 'AGENT_AUTH'
  | 'AGENT_RATE_LIMIT'
  | 'AGENT_TIMEOUT'
  | 'AGENT_NETWORK'
  | 'AGENT_MALFORMED_OUTPUT'
  | 'AGENT_UNKNOWN_TOOL'
  | 'AGENT_TOOL_ARGS'
  | 'AGENT_LIMIT'
  | 'AGENT_CANCELLED'
  | 'AGENT_PROVIDER'
  | 'AGENT_COMPANY_BUSY'
  | 'AGENT_LIVE_NOT_READY'
  | 'AGENT_WRITE_FAILED';

export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export function asAgentError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  return new AgentError(
    'AGENT_NETWORK',
    'The agent provider could not complete the request.',
    true,
  );
}
