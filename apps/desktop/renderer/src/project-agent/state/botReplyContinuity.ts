import { parseQuietReply } from '@peer-agent/protocol';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import type { BotChatMessage, ConversationDisplayRow, ConversationRow, PendingBotInput } from './botConversationState';
import { answeredInputIds, isActivityRunning } from './botActivityState.ts';
import { isRetiredRecovery } from './recoveryPresentation.ts';
import type { BotAvatarMood } from './botAvatarState';
import type { BotNarrationSegment } from './botNarrationState';
import type { UserReplyWait } from './userReceiptState';

export interface AwaitingBotInput { readonly inputId: string; readonly deliveryIssue?: boolean }
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
  /** Authoritative runtime recovery feedback, projected for display only. */
  readonly recovery?: import('@peer-agent/protocol').BotRecoveryStatus;
}
export type BotConversationViewRow = Exclude<ConversationRow, { type: 'message' }>
  | (Extract<ConversationRow, { type: 'message' }> & { readonly replyWait?: UserReplyWait })
  | BotReplyRow;

/**
 * One user send is one anchor, whichever spelling the host used.
 * Message id, raw input id and `input-${inputId}` name the same receipt.
 */
export function anchorAliases(messages: readonly BotChatMessage[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const ensure = (id: string) => {
    let set = map.get(id);
    if (!set) { set = new Set([id]); map.set(id, set); }
    return set;
  };
  const link = (leftId: string, rightId: string) => {
    if (!leftId || !rightId) return;
    const left = ensure(leftId);
    const right = ensure(rightId);
    if (left === right) return;
    for (const id of right) left.add(id);
    for (const id of left) map.set(id, left);
  };
  for (const message of messages) {
    if (message.kind !== 'user_input' || !message.inputId) continue;
    link(message.id, message.inputId);
    link(message.id, `input-${message.inputId}`);
  }
  return map;
}

export function anchorAnswered(answered: ReadonlySet<string>, aliases: ReadonlyMap<string, ReadonlySet<string>>, id: string): boolean {
  if (answered.has(id)) return true;
  const set = aliases.get(id);
  if (!set) return false;
  for (const alias of set) if (answered.has(alias)) return true;
  return false;
}

/** A received input is answered once any spelling of its anchor is on a reply. */
export function awaitingInputAnswered(messages: readonly BotChatMessage[], inputId: string): boolean {
  const answered = answeredInputIds(messages);
  const aliases = anchorAliases(messages);
  return anchorAnswered(answered, aliases, inputId) || anchorAnswered(answered, aliases, `input-${inputId}`);
}

/** Display identity only. Original messages, execution attempts and detail records stay intact. */
export function continuousReplyRows(rows: readonly ConversationDisplayRow[], messages: readonly BotChatMessage[],
  awaiting: readonly AwaitingBotInput[], pending: readonly PendingBotInput[], identityCache = new Map<string, string>(), stoppingTurnId?: string): BotConversationViewRow[] {
  const turns = new Map(messages.filter(message => message.kind === 'agent_turn').map(message => [message.id, message]));
  const answered = answeredInputIds(messages);
  const aliases = anchorAliases(messages);
  const claimed = new Set<string>();
  const answeredId = (id: string) => anchorAnswered(answered, aliases, id);
  const claim = (id: string) => {
    claimed.add(id);
    const set = aliases.get(id);
    if (set) for (const alias of set) claimed.add(alias);
  };
  const local = new Map(awaiting.map(input => [`input-${input.inputId}`, input]));
  for (const input of pending) {
    if (input.state === 'failed' || input.state === 'unknown' || input.state === 'rejected') local.delete(`input-${input.inputId}`);
    else if (input.state === 'received' && !local.has(`input-${input.inputId}`)) local.set(`input-${input.inputId}`, input);
  }
  const settled = (message: BotChatMessage) => message.dispositions.some(mark =>
    ['answered', 'stopped', 'superseded', 'out_of_scope'].includes(mark.kind));
  // Recover the newest unanswered input run from history. A reply for A can be
  // appended after B/C were received; the boundary is A's input, not its reply.
  const restored = new Set<string>();
  for (const message of [...messages].reverse()) {
    if ((message.kind === 'agent_reply' || message.kind === 'system_card'
      && message.cards.some(card => ['agent_stopped', 'agent_unavailable'].includes(card.kind)))
      && !message.replyTo.length && !turns.get(message.turnId ?? '')?.replyTo.length) break;
    if (message.kind !== 'user_input' || !message.inputId) continue;
    if (answeredId(message.id) || settled(message)) break;
    if (!message.pending || message.pending === 'received') restored.add(message.id);
  }
  const result: BotConversationViewRow[] = [];
  const open = new Map<string, MutableReply>();
  const openAnchors = new Map<string, MutableReply>();
  const byTurn = new Map<string, MutableReply>();
  const used = new Set<string>();
  const inputs = messages.filter(message => message.kind === 'user_input');
  const anchorBySpelling = new Map<string, string>();
  const inputOrder = new Map<string, number>();
  for (const [index, message] of inputs.entries()) {
    if (!message.inputId) continue;
    const anchor = `input-${message.inputId}`;
    inputOrder.set(anchor, index);
    for (const id of aliases.get(message.id) ?? []) anchorBySpelling.set(id, anchor);
  }
  const canonicalAnchor = (id: string) => anchorBySpelling.get(id) ?? id;
  const groups: MutableReply[] = [];
  const create = (identity: string, replyTo: readonly string[]) => {
    const anchor = replyTo.map(canonicalAnchor).filter(id => id.startsWith('input-')).sort((a, b) =>
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
    for (const id of replyTo) {
      if (!group.replyTo.some(existing => canonicalAnchor(existing) === canonicalAnchor(id))) group.replyTo.push(id);
    }
  };
  for (const row of rows) {
    if (row.type === 'separator') { result.push(row); continue; }
    if (row.type === 'activity') {
      const activity = row.activity;
      const work = activity.workId || activity.turnId;
      const explicit = (activity.replyTo ?? []).filter(Boolean);
      const anchors = anchorKey(explicit.map(canonicalAnchor));
      const group = byTurn.get(activity.turnId) ?? open.get(work)
        ?? (anchors ? openAnchors.get(anchors) : undefined)
        ?? create(activity.turnId, explicit);
      if (group.message?.kind === 'system_card' && group.message.turnId !== activity.turnId) group.message = undefined;
      group.activity = activity;
      group.stopping = stoppingTurnId === activity.turnId;
      if (!identityCache.has(activity.turnId)) identityCache.set(activity.turnId, group.id);
      if (!group.aliases.includes(activity.turnId)) group.aliases.push(activity.turnId);
      associate(group, explicit);
      byTurn.set(activity.turnId, group); open.set(work, group);
      if (anchors) openAnchors.set(anchors, group);
      appendUpdates(group, activity.turnId, (activity.segments ?? []).flatMap(segment => segment.kind === 'text' ? [segment] : []));
      if (activity.replyText) appendConclusion(group, activity.turnId, activity.replyText);
      continue;
    }
    const message = row.message;
    const finalText = message.kind === 'agent_reply' ? parseQuietReply(message.content) : undefined;
    if (finalText?.isPureQuiet) continue;
    const failure = message.kind === 'system_card' && message.cards.some(card => ['agent_stopped', 'agent_unavailable'].includes(card.kind));
    if (!['agent_reply', 'agent_turn'].includes(message.kind) && !failure || isRetiredRecovery(message.cards)) {
      result.push(row); continue;
    }
    const turnId = message.turnId || message.id;
    const turn = turns.get(turnId);
    const replyTo = message.replyTo.length ? message.replyTo : turn?.replyTo ?? [];
    const work = message.meta.workId || turn?.meta.workId || turnId;
    const anchors = anchorKey(replyTo.map(canonicalAnchor));
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
      ?? (row.activity ? (row.activity.segments ?? []).flatMap(segment => segment.kind === 'text' ? [segment] : []) : undefined) ?? row.narration ?? []);
    if (turn?.displayContract === 2 || message.displayContract === 2) group.segmented = true;
    if (message.kind === 'agent_reply') {
      appendConclusion(group, turnId, finalText?.leadingText ?? message.content);
      // The delivered canonical reply is the reading-column body; streamed public text
      // becomes process (ADR87 D6; legacy delivered records collapse the same way, D7.3).
      if (group.paragraphs.length > 1) {
        const answer = group.paragraphs.at(-1)!;
        group.paragraphs = [answer];
        group.paragraphIndex = new Map([[answer.id, 0]]);
      }
      group.message = message;
      for (const [key, value] of open) if (value === group) open.delete(key);
      for (const [key, value] of openAnchors) if (value === group) openAnchors.delete(key);
    } else {
      if (failure) group.message = message;
      open.set(work, group);
      if (anchors) openAnchors.set(anchors, group);
    }
  }
  // A receipt is not a reply. Only real server rows claim the corresponding input aliases.
  for (const group of groups) for (const id of group.replyTo) claim(id);
  return result.map(row => {
    if (row.type !== 'message' || row.message.kind !== 'user_input') return row;
    const message = row.message;
    if (!message.inputId || message.pending && message.pending !== 'received'
      || claimed.has(message.id) || answeredId(message.id) || settled(message)) return row;
    const receipt = local.get(`input-${message.inputId}`);
    if (!receipt && !restored.has(message.id) && message.pending !== 'received'
      && !message.dispositions.some(mark => mark.kind === 'queued')) return row;
    return { ...row, replyWait: receipt?.deliveryIssue ? 'deliveryIssue' : 'waiting' };
  });
}

interface MutableReply {
  type: 'reply'; id: string;
  replyTo: string[]; aliases: string[]; messages: BotChatMessage[]; paragraphs: ReplyParagraph[];
  message?: BotChatMessage; activity?: ProjectAgentActivity; stopping?: boolean;
  paragraphIndex: Map<string, number>;
  /** Any host-classified public text or contract marker reached this group (ADR87 D4). */
  segmented?: boolean;
}

const anchorKey = (ids: readonly string[]) => ids.length ? JSON.stringify([...ids].sort()) : '';

function appendUpdates(group: MutableReply, turnId: string, updates: readonly (ReplyParagraph & { role?: 'opening' | 'narration' })[]) {
  for (const update of updates) {
    if (!update.text.trim()) continue;
    if (update.role) group.segmented = true;
    // Host-classified narration renders in the process, never as a reading-column bubble (ADR87 D6).
    if (update.role === 'narration') continue;
    const id = `${turnId}:${update.id}`;
    const index = group.paragraphIndex.get(id);
    if (index === undefined) { group.paragraphIndex.set(id, group.paragraphs.length); group.paragraphs.push({ id, text: update.text }); }
    else group.paragraphs[index] = { id, text: update.text };
  }
}
function appendConclusion(group: MutableReply, turnId: string, text: string) {
  if (!text.trim()) return;
  const last = group.paragraphs.at(-1);
  // Delivery keeps the last paragraph as the reading column (ADR87 D6/D7.3).
  // Only an exact reuse of that last paragraph may keep its node. Skipping on an
  // earlier match, or on a similar/narrower restatement, would leave a streamed
  // paragraph in place of the delivered reply.
  if (last && last.text.trim().replace(/\s+/g, ' ') === text.trim().replace(/\s+/g, ' ')) return;
  group.paragraphs.push({ id: `${turnId}:conclusion`, text });
}

export function replyRowContains(row: BotConversationViewRow, id: string | null | undefined): boolean {
  return Boolean(id && (row.type === 'reply' ? row.aliases.includes(id) || row.activity?.turnId === id
    : row.type === 'message' && row.message.id === id));
}

export function replyRowRunning(row: BotReplyRow): boolean {
  return isActivityRunning(row.activity ?? null);
}

function messageBodyVisible(message: BotChatMessage, narration: readonly Pick<BotNarrationSegment, 'text'>[] | undefined): boolean {
  if (message.content.trim()) return true;
  if (narration?.some(segment => segment.text.trim())) return true;
  return message.cards.some(card => card.content.trim()
    || ['question', 'familiarize', 'agent_stopped', 'agent_unavailable', 'confirm_result'].includes(card.kind));
}

/** An empty historical assistant shell is not a second speaker. */
export function conversationRowShowsAuthor(row: BotConversationViewRow): boolean {
  if (row.type === 'reply') {
    if (row.stopping) return true;
    if (row.activity && (isActivityRunning(row.activity) || row.activity.replyText.trim()
      || row.activity.segments.some(segment => segment.kind === 'text' ? Boolean(segment.text.trim()) : segment.kind === 'tool'))) return true;
    if (row.paragraphs.some(paragraph => paragraph.text.trim())) return true;
    return Boolean(row.message && messageBodyVisible(row.message, undefined));
  }
  if (row.type !== 'message') return false;
  const failure = row.message.cards.some(card => card.kind === 'agent_stopped' || card.kind === 'agent_unavailable');
  const eligible = ['agent_reply', 'agent_turn'].includes(row.message.kind)
    || (failure && (!isRetiredRecovery(row.message.cards) || Boolean(row.narration?.length)));
  if (!eligible) return false;
  return messageBodyVisible(row.message, row.narration);
}

export function replyRowMood(row: BotReplyRow, options?: { readonly showToolMood?: boolean }): BotAvatarMood {
  if (row.activity?.phase === 'awaiting_permission') return 'needs_you';
  if (!replyRowRunning(row) && row.message?.cards.some(card => card.kind === 'agent_unavailable')) return 'error';
  if (row.activity?.phase === 'error') return 'error';
  if (row.activity?.recovery || row.activity?.phase === 'waiting') return 'waiting_provider';
  if (isActivityRunning(row.activity ?? null)) {
    return row.activity?.phase === 'tool' && options?.showToolMood !== false ? 'working' : 'thinking';
  }
  return 'idle';
}
