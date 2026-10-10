import type { AgentActivity } from '@peer-agent/protocol';

const states = new Set(['queued', 'started', 'update', 'question', 'answer', 'reported', 'verified', 'ended', 'cancelled', 'blocked']);
export function readAgentActivity(value: unknown): AgentActivity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.eventId !== 'string' || typeof item.sessionId !== 'string' || !item.sessionId
    || typeof item.name !== 'string' || !item.name || typeof item.state !== 'string' || !states.has(item.state)) return undefined;
  return { eventId: item.eventId, sessionId: item.sessionId, name: item.name.slice(0, 100), state: item.state as AgentActivity['state'] };
}

export function agentIdentityTone(sessionId: string): 'violet' | 'cyan' | 'amber' | 'rose' {
  let hash = 0;
  for (const char of sessionId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return (['violet', 'cyan', 'amber', 'rose'] as const)[hash % 4]!;
}
