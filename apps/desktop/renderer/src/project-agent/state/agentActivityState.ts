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

export const agentActivityPresentationId = (activity: AgentActivity) => `agent-activity:${activity.sessionId}`;

export function agentIdentity(sessionId: string) {
  let hash = 0;
  for (const char of sessionId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return { tone: (['violet', 'cyan', 'amber', 'rose'] as const)[hash % 4]!, icon: icons[((hash >>> 3) ^ hash) & 7]! };
}

/** History describes what happened; only current host facts can animate it. */
export function agentActivityRunning(activity: AgentActivity, work: BotWorkIndex): boolean {
  if (!work.available) return false;
  const session = work.byId.get(activity.sessionId);
  return !!session && session.coordination?.phase !== 'stopping'
    && ['starting', 'running', 'verifying'].includes(session.status);
}

export function currentAgentActivity(activity: AgentActivity, work: BotWorkIndex): AgentActivity {
  const session = work.available ? work.byId.get(activity.sessionId) : undefined;
  if (!session) return activity;
  const state: AgentActivity['state'] = session.status === 'queued' ? 'queued'
    : ['starting','running'].includes(session.status) ? 'started'
    : session.status === 'verifying' ? 'verifying'
    : session.status === 'result_ready' ? 'reported'
    : session.status === 'accepted' ? 'ended'
    : session.status === 'cancelled' ? 'cancelled' : 'blocked';
  const {verificationProgress: _historicalProgress,...identity} = activity;
  return {...identity,state,name:session.title || activity.name,
    ...(state === 'verifying' && session.verificationProgress ? {verificationProgress:session.verificationProgress} : {})};
}

/** One presentation slot per Agent; its source events remain unchanged and available in details. */
export function coalesceAgentActivity<T extends { readonly kind: string; readonly createdAt?: string; readonly agentActivity?: AgentActivity }>(messages: readonly T[]): T[] {
  const slots = new Map<string, number>();
  const rows: T[] = [];
  for (const message of messages) {
    const activity = message.kind === 'agent_activity' ? message.agentActivity : undefined;
    if (!activity) { rows.push(message); continue; }
    const slot = slots.get(activity.sessionId);
    if (slot === undefined) { slots.set(activity.sessionId,rows.length); rows.push(message); }
    else rows[slot] = {...rows[slot]!,agentActivity:activity};
  }
  return rows;
}
