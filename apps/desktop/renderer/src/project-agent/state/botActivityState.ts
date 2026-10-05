import type { ProjectAgentActivity } from '@peer-agent/protocol';
import type { BotChatMessage, BotToolRound, ConversationRow } from './botConversationState';

const TERMINAL = new Set(['done', 'error', 'stopped', 'disposed']);
export const isActivityRunning = (activity: ProjectAgentActivity | null) => Boolean(activity && !TERMINAL.has(activity.phase));

/** Push and read snapshots share this ordering boundary; late reads cannot rewind a turn. */
export function mergeBotActivity(current: ProjectAgentActivity | null, incoming: ProjectAgentActivity | null | undefined, workspaceId: string): ProjectAgentActivity | null {
  if (!incoming || incoming.workspaceId !== workspaceId || !incoming.turnId || !Number.isFinite(incoming.revision)) return current;
  if (!current) return incoming;
  if (current.turnId === incoming.turnId) return incoming.revision > current.revision ? incoming : current;
  if (incoming.startedAt < current.startedAt) return current;
  if (incoming.startedAt === current.startedAt && incoming.revision <= current.revision && current.phase !== 'disposed') return current;
  return incoming;
}

export function visibleBotActivity(activity: ProjectAgentActivity | null, messages: readonly BotChatMessage[]): ProjectAgentActivity | null {
  if (!activity || activity.phase === 'disposed') return null;
  if (messages.some(message => message.turnId === activity.turnId && ['agent_reply', 'system_card'].includes(message.kind))) return null;
  if (TERMINAL.has(activity.phase) && messages.some(message => message.id === activity.turnId)) return null;
  return activity;
}

/** Linear handoff projection: streaming updates must not scan history once per reply. */
export function attachBotProcesses(rows: readonly ConversationRow[], messages: readonly BotChatMessage[], activity: ProjectAgentActivity | null): ConversationRow[] {
  const byTurn = new Map(messages.filter(message => message.kind === 'agent_turn').map(message => [message.id, message.rounds]));
  const legacy = new Map<string, readonly BotToolRound[]>();
  let preceding: readonly BotToolRound[] = [];
  for (const message of messages) {
    if (message.kind === 'agent_turn') preceding = message.rounds;
    else if (message.kind === 'agent_reply' && !message.turnId) legacy.set(message.id, preceding);
  }
  return rows.map(row => row.type === 'message' && row.message.kind !== 'user_input' ? {
    ...row, processRounds: row.message.turnId ? byTurn.get(row.message.turnId) ?? [] : legacy.get(row.message.id) ?? [],
    ...(activity && row.message.turnId === activity.turnId && activity.phase !== 'disposed' ? { activity } : {}),
  } : row);
}
