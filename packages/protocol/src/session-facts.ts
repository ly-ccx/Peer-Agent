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
  cancellationPhase?: string; takeoverPhase?: string;
}): SessionFactSnapshot {
  const verificationActive = input.verificationActive === true;
  let status: WorkSessionStatus;
  if (input.status === 'cancelled') status = 'cancelled';
  else if (input.status === 'failed') status = 'failed';
  else if (input.accepted) status = 'accepted';
  else if (input.cancellationPhase === 'awaiting_outcome' || input.takeoverPhase === 'awaiting_outcome') status = 'awaiting_outcome';
  else if (input.cancellationPhase === 'stopping') status = 'stopping';
  else if (input.takeoverPhase === 'stopping') status = 'starting';
  else if (input.needsUser || input.runnerStatus === 'waiting_user') status = 'waiting_user';
  else if (input.blockedReason === 'waiting_parent_agent' && input.phase !== 'paused' && !input.superseded && input.runnerStatus !== 'paused') status = 'waiting_agent';
  else if (input.runnerStatus === 'blocked') status = 'waiting_user';
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
