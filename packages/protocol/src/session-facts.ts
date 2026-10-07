import type { WorkSessionStatus } from './delegation.ts';

export interface SessionFactSnapshot {
  readonly status: WorkSessionStatus;
  readonly verificationActive: boolean;
  readonly needsUser: boolean;
  readonly blockedReason?: string;
}

export function deriveSessionFacts(input: {
  status?: string; phase?: string; runnerStatus?: string; accepted?: boolean;
  superseded?: boolean; needsUser?: boolean; blockedReason?: string; verificationActive?: boolean;
}): SessionFactSnapshot {
  const verificationActive = input.verificationActive === true;
  let status: WorkSessionStatus;
  if (input.status === 'cancelled') status = 'cancelled';
  else if (input.status === 'failed') status = 'failed';
  else if (input.accepted) status = 'accepted';
  else if (input.needsUser || ['blocked', 'waiting_user'].includes(input.runnerStatus || '')) status = 'waiting_user';
  else if (verificationActive) status = 'verifying';
  else if (input.status === 'completed' && ['running', 'starting', 'waiting_provider', 'resuming_after_compaction'].includes(input.runnerStatus || '')) status = 'running';
  else if (input.status === 'completed') status = 'result_ready';
  else if (input.superseded) status = 'superseded';
  else if (input.phase === 'paused') status = 'paused';
  else if (input.phase === 'starting') status = 'starting';
  else if (['approved', 'accepted', 'paused', 'interrupted'].includes(input.status || '') || input.phase === 'queued') status = 'queued';
  else status = 'running';
  return { status, verificationActive: status === 'verifying', needsUser: status === 'waiting_user',
    ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}) };
}
