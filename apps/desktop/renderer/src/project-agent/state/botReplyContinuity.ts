import type { ProjectAgentActivity } from '@peer-agent/protocol';
import type { BotChatMessage, ConversationDisplayRow, ConversationRow, PendingBotInput } from './botConversationState';
import { answeredInputIds, isActivityRunning } from './botActivityState.ts';
import { isRetiredRecovery } from './recoveryPresentation.ts';
import type { BotAvatarMood } from './botAvatarState';

export interface AwaitingBotInput { readonly inputId: string; readonly createdAt: string; readonly deliveryIssue?: boolean }
export interface ReplyParagraph { readonly id: string; readonly text: string }
export interface BotReplyRow {
  readonly type: 'reply';
  readonly id: string;
  readonly replyTo: readonly string[];
  readonly aliases: readonly string[];
  readonly messages: readonly BotChatMessage[];
  readonly paragraphs: readonly ReplyParagraph[];
  readonly message?: BotChatMessage;
  readonly activity?: ProjectAgentActivity;
  readonly stopping?: boolean;
  readonly pending?: { readonly since: string; readonly sending: boolean; readonly restored: boolean; readonly deliveryIssue?: boolean };
}
export type BotConversationViewRow = ConversationRow | BotReplyRow;

/** Display identity only. Original messages, execution attempts and detail records stay intact. */
export function continuousReplyRows(rows: readonly ConversationDisplayRow[], messages: readonly BotChatMessage[],
  awaiting: readonly AwaitingBotInput[], pending: readonly PendingBotInput[], identityCache = new Map<string, string>(), stoppingTurnId?: string): BotConversationViewRow[] {
  const turns = new Map(messages.filter(message => message.kind === 'agent_turn').map(message => [message.id, message]));
  const answered = answeredInputIds(messages);
  const local = new Map(awaiting.map(input => [`input-${input.inputId}`, input]));
  for (const input of pending) {
    if (input.state === 'failed' || input.state === 'unknown') local.delete(`input-${input.inputId}`);
    else local.set(`input-${input.inputId}`, { ...local.get(`input-${input.inputId}`), ...input });
  }
  // Reopen only the most recent unanswered input run. Absence of Activity is not execution truth.
  const restored = new Map<string, AwaitingBotInput>();
  for (const message of [...messages].reverse()) {
    if (message.kind !== 'user_input' || !message.inputId) continue;
    if (answered.has(message.id) || message.dispositions.some(mark => ['stopped', 'superseded', 'out_of_scope'].includes(mark.kind))) break;
    if (message.pending !== 'failed' && message.pending !== 'unknown') restored.set(message.id, { inputId: message.inputId, createdAt: message.createdAt });
  }
  const result: BotConversationViewRow[] = [];
  const open = new Map<string, MutableReply>();
  const openAnchors = new Map<string, MutableReply>();
  const byTurn = new Map<string, MutableReply>();
  const used = new Set<string>();
  const inputOrder = new Map(messages.filter(message => message.kind === 'user_input').map((message, index) => [message.id, index]));
  const claimed = new Set<string>();
  const groups: MutableReply[] = [];
  const create = (identity: string, replyTo: readonly string[]) => {
    const anchor = [...replyTo].filter(id => id.startsWith('input-')).sort((a, b) =>
      (inputOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (inputOrder.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b))[0];
    const preferred = identityCache.get(identity) ?? (anchor ? identityCache.get(anchor) ?? `reply-${anchor}` : `reply-${identity}`);
    let id = preferred;
    for (let occurrence = 2; used.has(id); occurrence += 1) id = `${preferred}:${occurrence}`;
    used.add(id); identityCache.set(identity, id);
    const group: MutableReply = { type: 'reply', id, replyTo: [...replyTo], aliases: [], messages: [], paragraphs: [], paragraphIndex: new Map() };
    groups.push(group); result.push(group);
    return group;
  };
  const associate = (group: MutableReply, replyTo: readonly string[]) => {
    for (const id of replyTo) if (!group.replyTo.includes(id)) group.replyTo.push(id);
  };
  for (const row of rows) {
    if (row.type === 'separator') { result.push(row); continue; }
    if (row.type === 'activity') {
      const activity = row.activity;
      const work = activity.workId || activity.turnId;
      const anchors = anchorKey(activity.replyTo);
      const group = byTurn.get(activity.turnId) ?? open.get(work) ?? (anchors ? openAnchors.get(anchors) : undefined) ?? create(activity.turnId, activity.replyTo);
      if (group.message?.kind === 'system_card' && group.message.turnId !== activity.turnId) group.message = undefined;
      group.activity = activity;
      group.stopping = stoppingTurnId === activity.turnId;
      if (!identityCache.has(activity.turnId)) identityCache.set(activity.turnId, group.id);
      if (!group.aliases.includes(activity.turnId)) group.aliases.push(activity.turnId);
      associate(group, activity.replyTo);
      byTurn.set(activity.turnId, group); open.set(work, group);
      if (anchors) openAnchors.set(anchors, group);
      appendUpdates(group, activity.turnId, activity.segments.flatMap(segment => segment.kind === 'text' ? [segment] : []));
      if (activity.replyText) appendConclusion(group, activity.turnId, activity.replyText);
      continue;
    }
    const message = row.message;
    const failure = message.kind === 'system_card' && message.cards.some(card => ['agent_stopped', 'agent_unavailable'].includes(card.kind));
    if (!['agent_reply', 'agent_turn'].includes(message.kind) && !failure || isRetiredRecovery(message.cards)) {
      result.push(row); continue;
    }
    const turnId = message.turnId || message.id;
    const turn = turns.get(turnId);
    const replyTo = message.replyTo.length ? message.replyTo : turn?.replyTo ?? [];
    const work = message.meta.workId || turn?.meta.workId || turnId;
    const anchors = anchorKey(replyTo);
    const previousTurn = byTurn.get(turnId);
    let group = previousTurn ?? open.get(work) ?? (anchors ? openAnchors.get(anchors) : undefined);
    // A delivered reply ends this visible response. A later result is a new message.
    const additionalReply = group?.message?.kind === 'agent_reply';
    if (additionalReply) group = undefined;
    group ??= create(additionalReply ? message.id : turnId, replyTo);
    if (message.kind === 'agent_turn' && group.message?.kind === 'system_card' && group.message.turnId !== turnId) group.message = undefined;
    associate(group, replyTo);
    group.messages.push(message);
    for (const id of [message.id, ...(!previousTurn || previousTurn === group ? [turnId] : [])]) if (!group.aliases.includes(id)) group.aliases.push(id);
    identityCache.set(message.id, group.id);
    if (!identityCache.has(turnId)) identityCache.set(turnId, group.id);
    if (!additionalReply) byTurn.set(turnId, group);
    appendUpdates(group, turnId, turn?.publicUpdates ?? message.publicUpdates
      ?? row.activity?.segments.flatMap(segment => segment.kind === 'text' ? [segment] : []) ?? row.narration ?? []);
    if (message.kind === 'agent_reply') {
      appendConclusion(group, turnId, message.content);
      group.message = message;
      for (const [key, value] of open) if (value === group) open.delete(key);
      for (const [key, value] of openAnchors) if (value === group) openAnchors.delete(key);
    } else {
      if (failure) group.message = message;
      open.set(work, group);
      if (anchors) openAnchors.set(anchors, group);
    }
  }
  // Active rows claim only their own anchors; another input keeps its own pending response.
  for (const group of groups) if (group.message?.kind !== 'agent_reply') for (const id of group.replyTo) claimed.add(id);
  const unclaimed = [...new Map([...restored, ...local])].filter(([id]) => !answered.has(id) && !claimed.has(id));
  if (unclaimed.length) {
    unclaimed.sort((a, b) => (inputOrder.get(a[0]) ?? Number.MAX_SAFE_INTEGER) - (inputOrder.get(b[0]) ?? Number.MAX_SAFE_INTEGER)
      || a[1].createdAt.localeCompare(b[1].createdAt));
    const ids = unclaimed.map(([id]) => id);
    const group = create(ids[0]!, ids);
    const since = unclaimed.map(([, input]) => input.createdAt).filter(Boolean).sort()[0] || '';
    group.pending = { since, sending: unclaimed.some(([id]) => pending.some(input => `input-${input.inputId}` === id && input.state === 'sending')),
      deliveryIssue: unclaimed.some(([, input]) => input.deliveryIssue),
      restored: !unclaimed.some(([id]) => local.has(id)) };
  }
  for (const group of groups) {
    if (group.message || group.activity || group.pending) continue;
    const input = group.replyTo.map(id => local.get(id) ?? restored.get(id)).find(Boolean);
    group.pending = { since: input?.createdAt || '', sending: false, restored: !group.replyTo.some(id => local.has(id)), deliveryIssue: input?.deliveryIssue };
  }
  return result;
}

interface MutableReply {
  type: 'reply'; id: string;
  replyTo: string[]; aliases: string[]; messages: BotChatMessage[]; paragraphs: ReplyParagraph[];
  message?: BotChatMessage; activity?: ProjectAgentActivity; pending?: BotReplyRow['pending']; stopping?: boolean;
  paragraphIndex: Map<string, number>;
}

const anchorKey = (ids: readonly string[]) => ids.length ? JSON.stringify([...ids].sort()) : '';

function appendUpdates(group: MutableReply, turnId: string, updates: readonly ReplyParagraph[]) {
  for (const update of updates) {
    if (!update.text.trim()) continue;
    const id = `${turnId}:${update.id}`;
    const index = group.paragraphIndex.get(id);
    if (index === undefined) { group.paragraphIndex.set(id, group.paragraphs.length); group.paragraphs.push({ id, text: update.text }); }
    else group.paragraphs[index] = { id, text: update.text };
  }
}
function appendConclusion(group: MutableReply, turnId: string, text: string) {
  if (!text.trim()) return;
  const last = group.paragraphs.at(-1);
  // Reusing an actual opening as the final reply must retain its paragraph node.
  if (last && last.text.trim().replace(/\s+/g, ' ') === text.trim().replace(/\s+/g, ' ')) return;
  group.paragraphs.push({ id: `${turnId}:conclusion`, text });
}

export function replyRowContains(row: BotConversationViewRow, id: string | null | undefined): boolean {
  return Boolean(id && (row.type === 'reply' ? row.aliases.includes(id) || row.activity?.turnId === id
    : row.type === 'message' && row.message.id === id));
}

export function replyRowRunning(row: BotReplyRow): boolean {
  return isActivityRunning(row.activity ?? null) || Boolean(row.pending && !row.pending.restored && !row.pending.deliveryIssue);
}

export function replyRowMood(row: BotReplyRow): BotAvatarMood {
  if (row.activity?.phase === 'awaiting_permission') return 'needs_you';
  if (row.pending?.deliveryIssue || !isActivityRunning(row.activity ?? null) && row.message?.cards.some(card => card.kind === 'agent_unavailable')) return 'error';
  if (row.activity?.phase === 'error') return 'error';
  if (row.activity?.recovery || row.activity?.phase === 'waiting' || row.pending && !row.pending.restored) return 'waiting_provider';
  if (isActivityRunning(row.activity ?? null)) return row.activity?.phase === 'tool' ? 'working' : 'thinking';
  return 'idle';
}
