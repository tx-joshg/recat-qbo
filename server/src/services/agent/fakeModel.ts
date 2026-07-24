import type { AgentModel, AgentModelInput, AgentModelTurn } from './model.js';

/** Deterministic test/demo model. Production wiring must never select it. */
export class FakeAgentModel implements AgentModel {
  readonly provider = 'fake';
  readonly model = 'fake-agent-v1';
  readonly inputs: AgentModelInput[] = [];
  private index = 0;

  constructor(private readonly turns: AgentModelTurn[]) {}

  async nextTurn(input: AgentModelInput, signal: AbortSignal): Promise<AgentModelTurn> {
    if (signal.aborted) throw signal.reason;
    this.inputs.push(structuredClone(input));
    const turn = this.turns[this.index];
    this.index += 1;
    if (!turn) throw new Error('FakeAgentModel has no remaining turn.');
    return structuredClone(turn);
  }
}
