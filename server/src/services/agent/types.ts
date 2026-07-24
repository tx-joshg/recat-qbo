import type { AgentJobStatus, AutopilotMode } from '@recat/shared';

export const AUTOPILOT_MODES = ['off', 'shadow', 'live'] as const satisfies readonly AutopilotMode[];
export const AGENT_JOB_STATUSES = [
  'queued',
  'running',
  'retry',
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly AgentJobStatus[];

const TRANSITIONS: Readonly<Record<AgentJobStatus, ReadonlySet<AgentJobStatus>>> = {
  queued: new Set(['running', 'cancelled']),
  running: new Set(['completed', 'retry', 'failed', 'cancelled']),
  retry: new Set(['running', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export class AgentStateError extends Error {
  readonly code = 'AGENT_STATE';

  constructor(message: string) {
    super(message);
    this.name = 'AgentStateError';
  }
}

export function assertAgentJobTransition(from: AgentJobStatus, to: AgentJobStatus): void {
  if (!TRANSITIONS[from].has(to)) {
    throw new AgentStateError(`Agent job cannot transition from ${from} to ${to}.`);
  }
}

export interface JobLease {
  status: AgentJobStatus;
  lockOwner: string | null;
  leaseExpiresAt: Date | null;
}

export function assertActiveJobLease(job: JobLease, owner: string, now = new Date()): void {
  if (
    job.status !== 'running' ||
    job.lockOwner !== owner ||
    job.leaseExpiresAt === null ||
    job.leaseExpiresAt.getTime() <= now.getTime()
  ) {
    throw new AgentStateError('The worker no longer owns an active lease for this job.');
  }
}

export interface CompanyWriteLease {
  owner: string;
  leaseExpiresAt: Date;
}

export function ownsCompanyWriteLease(
  lease: CompanyWriteLease | null,
  owner: string,
  now = new Date(),
): boolean {
  return (
    lease !== null &&
    lease.owner === owner &&
    lease.leaseExpiresAt.getTime() > now.getTime()
  );
}
