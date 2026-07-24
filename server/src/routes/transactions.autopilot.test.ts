import { describe, expect, it } from 'vitest';
import { currentShadowDecision } from './transactions.js';

function row(runHash: string, jobHash: string) {
  return {
    agentRuns: [
      {
        id: 'run-1',
        inputHash: runHash,
        completedAt: new Date('2026-07-23T12:00:00Z'),
        decision: { kind: 'skip', reasonCode: 'TEST', rationale: 'Test decision.' },
        validation: { ok: true },
        verifier: { verdict: 'agree', rationale: 'Verified.' },
      },
    ],
    agentJobs: [{ inputHash: jobHash }],
  };
}

describe('currentShadowDecision', () => {
  it('exposes evidence only for the current job input', () => {
    expect(currentShadowDecision(row('current', 'current'))).toMatchObject({
      runId: 'run-1',
      decision: { kind: 'skip' },
    });
  });

  it('hides obsolete evidence while a replacement job is pending', () => {
    expect(currentShadowDecision(row('old', 'current'))).toBeNull();
  });

  it('hides decisions rejected by the independent verifier', () => {
    const value = row('current', 'current');
    value.agentRuns[0]!.verifier = { verdict: 'disagree', rationale: 'Unsupported.' };
    expect(currentShadowDecision(value)).toBeNull();
  });
});
