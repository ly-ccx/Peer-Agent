import type { ProjectAgentActivity } from '@peer-agent/protocol';
import type { BotChatMessage, BotToolRound, ConversationRow, ConversationDisplayRow } from './botConversationState';
import { botNarration } from './botNarrationState.ts';

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

/** Folding a historical failure changes the thread, never the identity of its detail record. */
export function replyDetailsRow(id: string | null, rows: readonly ConversationDisplayRow[], messages: readonly BotChatMessage[]): ConversationDisplayRow | undefined {
  if (!id) return undefined;
  const exact = rows.find(row => row.type === 'message' && row.message.id === id);
  if (exact) return exact;
  const canonical = messages.find(message => message.id === id && message.kind !== 'agent_turn');
  if (canonical) return attachBotProcesses([{ type: 'message', message: canonical }], messages, null)[0];
  const handoff = [...rows].reverse().find(row => row.type === 'activity' ? row.activity.turnId === id
    : row.type === 'message' && row.message.turnId === id);
  if (handoff) return handoff;
  const delivered = [...messages].reverse().find(message => message.turnId === id && message.kind !== 'agent_turn');
  return delivered ? attachBotProcesses([{ type: 'message', message: delivered }], messages, null)[0] : undefined;
}

/** Durable receipt, internal slices and unrelated wakes cannot answer a user input. */
export function hasReplyForInput(messages: readonly BotChatMessage[], inputId: string): boolean {
  const target = `input-${inputId}`;
  const turns = new Set(messages.filter(message => message.kind === 'agent_turn' && message.replyTo.includes(target)).map(message => message.id));
  return messages.some(message => ['agent_reply', 'system_card'].includes(message.kind)
    && (message.replyTo.includes(target) || Boolean(message.turnId && turns.has(message.turnId))));
}

/** Linear handoff projection: streaming updates must not scan history once per reply. */
export function attachBotProcesses(rows: readonly ConversationRow[], messages: readonly BotChatMessage[], activity: ProjectAgentActivity | null): ConversationRow[] {
  const byTurn = new Map(messages.filter(message => message.kind === 'agent_turn').map(message => [message.id, message]));
  const legacy = new Map<string, readonly BotToolRound[]>();
  let preceding: readonly BotToolRound[] = [];
  for (const message of messages) {
    if (message.kind === 'user_input') preceding = [];
    else if (message.kind === 'agent_turn') preceding = message.rounds;
    else if (message.kind === 'agent_reply' && !message.turnId) legacy.set(message.id, preceding);
  }
  const narrated = new Set<string>();
  return rows.filter(row => row.type !== 'message' || row.message.kind !== 'agent_turn'
    || row.message.id !== activity?.turnId || !isActivityRunning(activity)).map(row => {
    if (row.type !== 'message' || row.message.kind === 'user_input') return row;
    const turn = row.message.turnId ? byTurn.get(row.message.turnId) : undefined;
    const processRounds = turn?.rounds ?? legacy.get(row.message.id) ?? [];
    // Completed calls carry host clocks in history. Interrupted activity may also
    // contain a preparing call that never reached dispatch or persisted rounds.
    const persistedProcess = Boolean(turn?.rounds.length) && activity?.phase === 'done';
    const live = activity && !persistedProcess && row.message.turnId === activity.turnId && activity.phase !== 'disposed' ? activity : undefined;
    // Internal rounds never become public text, including legacy user turns.
    const eligible = Boolean(live) || turn?.publicUpdates !== undefined;
    const updates = turn?.publicUpdates !== undefined ? turn.publicUpdates
      : live?.segments.flatMap(segment => segment.kind === 'text' ? [segment] : []) ?? [];
    const first = row.message.turnId && !narrated.has(row.message.turnId);
    if (first) narrated.add(row.message.turnId!);
    return { ...row, processRounds, ...(live ? { activity: live } : {}),
      narration: eligible && first ? botNarration(updates, row.message.content) : [] };
  });
}
