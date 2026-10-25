import type { AgentActivity } from '@peer-agent/protocol';
import type { PeerIconName } from '../../ui/icons';
import type { BotWorkIndex } from './botWorkState';

const states = new Set(['queued', 'started', 'update', 'question', 'answer', 'reported', 'verifying', 'verified', 'ended', 'cancelled', 'blocked']);
export function readAgentActivity(value: unknown): AgentActivity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.eventId !== 'string' || typeof item.sessionId !== 'string' || !item.sessionId
    || typeof item.name !== 'string' || !item.name || typeof item.state !== 'string' || !states.has(item.state)) return undefined;
  const progress = item.verificationProgress as AgentActivity['verificationProgress'];
  const validProgress = progress && typeof progress.continuationId === 'string'
    && Number.isFinite(Date.parse(progress.startedAt)) && Number.isFinite(Date.parse(progress.lastProgressAt))
    && Number.isSafeInteger(progress.observationCount) && progress.observationCount >= 0
    && ['ready', 'requesting', 'tools', 'completed'].includes(progress.phase);
  return { eventId: item.eventId, sessionId: item.sessionId, name: item.name.slice(0, 100), state: item.state as AgentActivity['state'],
    ...(validProgress ? { verificationProgress: progress } : {}) };
}

const icons = ['agentOrbit', 'agentBloom', 'agentPrism', 'agentWeave', 'agentSpark', 'agentFacet', 'agentLeaf', 'agentKnot'] as const satisfies readonly PeerIconName[];

export function agentIdentity(sessionId: string) {
  let hash = 0;
  for (const char of sessionId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return { tone: (['violet', 'cyan', 'amber', 'rose'] as const)[hash % 4]!, icon: icons[((hash >>> 3) ^ hash) & 7]! };
}

/** History describes what happened; only current host facts can animate it. */
export function agentActivityRunning(activity: AgentActivity, work: BotWorkIndex): boolean {
  if (!work.available || !['queued', 'started', 'verifying'].includes(activity.state)) return false;
  const session = work.byId.get(activity.sessionId);
  return !!session && session.coordination?.phase !== 'stopping'
    && ['starting', 'running', 'verifying'].includes(session.status);
}

/** Old publishers mapped two facts in one observation to the same visible report. */
export function coalesceAgentActivity<T extends { readonly kind: string; readonly createdAt?: string; readonly agentActivity?: AgentActivity }>(messages: readonly T[]): T[] {
  const reportedAt = new Map<string, string>();
  return messages.filter((message, index) => {
    const activity = message.kind === 'agent_activity' ? message.agentActivity : undefined;
    if (!activity) { reportedAt.clear(); return true; }
    const next = messages[index + 1];
    if (activity.state === 'verifying' && next?.kind === 'agent_activity'
      && next.agentActivity?.state === 'verifying' && next.agentActivity.sessionId === activity.sessionId) return false;
    if (activity.state !== 'reported') { reportedAt.delete(activity.sessionId); return true; }
    const at = message.createdAt;
    if (!at || !Number.isFinite(Date.parse(at))) return true;
    if (reportedAt.get(activity.sessionId) === at) return false;
    reportedAt.set(activity.sessionId, at);
    return true;
  });
}
