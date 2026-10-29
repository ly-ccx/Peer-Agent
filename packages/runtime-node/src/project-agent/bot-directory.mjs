/**
 * 机器人列表、详情、对话、任务和未读游标的汇集。
 * 不依赖桌面或 TUI。列表行交给 projectBotListItem。
 * 未读游标在 project-runtime/<workspaceId>/read-cursor.json。
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { projectBotListItem, sortBotList } from '@peer-agent/protocol';

import { pathOf } from '../data-store.mjs';
import { createBotProfileStore, isBotWorkspaceId } from './bot-profile-store.mjs';
import { projectBotAttention } from './attention.mjs';
import { projectReplyQuestions } from './question-lifecycle.mjs';

const VISIBLE_KINDS = new Set(['user_input', 'agent_reply', 'system_card', 'agent_activity']);
const PREVIEW_MAX = 80;

function fail(code) {
  return { ok: false, code };
}

function clip(value, limit = PREVIEW_MAX) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!Number.isInteger(limit) || limit < 0) return Array.from(text).slice(0, limit).join('');
  if (text.length <= limit) return text;
  let clipped = '', length = 0;
  for (const character of text) { if (length++ === limit) break; clipped += character; }
  return clipped;
}

function messageKind(message) {
  const kind = message?.kind || message?.type || message?.messageKind;
  return typeof kind === 'string' ? kind : '';
}

function messageText(message) {
  const text = typeof message?.content === 'string' ? message.content
    : typeof message?.text === 'string' ? message.text : '';
  if (text.trim()) return text;
  return (Array.isArray(message?.attachments) ? message.attachments : [])
    .map(item => typeof item?.name === 'string' ? item.name : '').filter(Boolean).join(', ');
}

function messageAt(message) {
  if (typeof message?.createdAt === 'string' && message.createdAt) return message.createdAt;
  if (typeof message?.at === 'string' && message.at) return message.at;
  return '';
}

export function isVisibleBotMessage(message) {
  const kind = messageKind(message);
  if (kind === 'agent_activity' && ['verifying', 'verified'].includes(message.agentActivity?.state)) return false;
  if (kind === 'system_card' && Array.isArray(message.cards) && message.cards.length && message.cards.every(card => card?.kind === 'verdict')) return false;
  if (VISIBLE_KINDS.has(kind)) return true;
  if (!kind && (message?.role === 'user' || message?.role === 'assistant')) return true;
  return false;
}

export function projectBotListMessage(message, previewLength = PREVIEW_MAX) {
  const kind = messageKind(message);
  const role = kind === 'user_input' || message?.role === 'user' ? 'user' : 'assistant';
  const surfacing = message?.kind === 'agent_activity' ? 'silent' : message?.meta?.surfacing || message?.surfacing;
  return {
    role,
    text: clip(messageText(message), previewLength),
    at: messageAt(message),
    ...(surfacing === 'silent' || message?.meta?.unread === false ? { countUnread: false } : {}),
  };
}

const FAMILIARIZE_OFFER = {
  kind: 'familiarize',
  text: '要我先熟悉一下这个项目吗？',
  action: '先熟悉一下',
};

export function createBotDirectory({
  rootDir = null,
  registry = null,
  readMessages = () => [],
  readConversationMessages = null,
  readInteractionPage = null,
  readInteractionProcess = null,
  readMessagesBatch = null,
  readSummaryMessages = null,
  readSummaryMessagesBatch = null,
  listSessions = () => [],
  readSessionsBatch = null,
  getSession = () => null,
  listApprovals = () => [],
  readApprovalsBatch = null,
  listConfirmations = () => [],
  readCards = () => [],
  readQuestionCards = readCards,
  now = () => new Date(),
} = {}) {
  const profiles = createBotProfileStore({ rootDir, now });

  function runtimeDir(workspaceId) {
    const base = rootDir ? path.join(rootDir, 'project-runtime') : pathOf('projectRuntime');
    return path.join(base, workspaceId);
  }

  function cursorFile(workspaceId) {
    return path.join(runtimeDir(workspaceId), 'read-cursor.json');
  }

  function stamp() {
    const value = now();
    return value instanceof Date ? value.toISOString() : String(value);
  }

  function profileIds() {
    const dir = rootDir ? path.join(rootDir, 'projects') : pathOf('projects');
    if (!existsSync(dir)) return [];
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && isBotWorkspaceId(entry.name))
      .map((entry) => entry.name);
  }

  function messagesOf(profile, batch = null) {
    if (!profile?.agentConversationId || typeof readMessages !== 'function') return [];
    const messages = batch instanceof Map && batch.has(profile.agentConversationId) ? batch.get(profile.agentConversationId)
      : readMessages(profile.agentConversationId, profile.workspaceId);
    return Array.isArray(messages) ? messages : [];
  }
  function summaryMessagesOf(profile, batch = null) {
    const messages = batch instanceof Map && batch.has(profile?.agentConversationId) ? batch.get(profile.agentConversationId)
      : readSummaryMessages && profile?.agentConversationId ? readSummaryMessages(profile.agentConversationId) : messagesOf(profile);
    return Array.isArray(messages) ? messages : [];
  }

  function readCursor(workspaceId) {
    const file = cursorFile(workspaceId);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return typeof parsed?.at === 'string' && parsed.at ? parsed : null;
    } catch {
      return null;
    }
  }

  function sessionsOf(workspaceId, batch = null) {
    const sessions = batch instanceof Map && batch.has(workspaceId) ? batch.get(workspaceId) : listSessions(workspaceId);
    return Array.isArray(sessions) ? sessions : [];
  }

  function projectRow(profile, messageBatch = null, approvalBatch = null, sessionBatch = null) {
    const messages = summaryMessagesOf(profile, messageBatch);
    const visible = messages.filter(message => isVisibleBotMessage(message) && messageKind(message) !== 'agent_activity');
    const last = visible.length ? projectBotListMessage(visible[visible.length - 1]) : null;
    const sessions = sessionsOf(profile.workspaceId, sessionBatch);
    const confirmations = listConfirmations(profile.workspaceId);
    const mappedSessions = sessions.map(session => ({ status: session?.status, updatedAt: session?.updatedAt }));
    const approvals = approvalBatch instanceof Map && approvalBatch.has(profile.workspaceId)
      ? approvalBatch.get(profile.workspaceId) : listApprovals(profile.workspaceId);
    const cards = readQuestionCards(profile.workspaceId);
    const attention = projectBotAttention({ profile, messages, sessions, cards: Array.isArray(cards) ? cards : [], approvals: Array.isArray(approvals) ? approvals : [],
      confirmations: Array.isArray(confirmations) ? confirmations : [], now: Date.parse(stamp()) });
    const item = projectBotListItem({
      profile: { ...profile },
      lastMessage: last,
      sessions: mappedSessions,
      attention,
      readCursor: readCursor(profile.workspaceId)?.at ?? null,
    });
    const deadline = attention.map(entry => entry.expiresAt).filter(value => Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    return {
      item: deadline ? { ...item, state: { ...item.state, attentionExpiresAt: deadline } } : item,
      attention,
      titles: sessions
        .map((session) => (typeof session?.title === 'string' ? session.title : ''))
        .filter(Boolean),
    };
  }

  function activeProfiles() {
    const rows = [];
    for (const workspaceId of profileIds()) {
      const profile = profiles.read(workspaceId);
      if (!profile || profile.status === 'archived') continue;
      rows.push(profile);
    }
    return rows;
  }

  function rows() {
    const current = activeProfiles();
    let messages = null;
    try { messages = (readSummaryMessagesBatch || readMessagesBatch)?.(current.map(profile => profile.agentConversationId).filter(Boolean)) ?? null; }
    catch { /* Existing single reads retain their normal failure behavior. */ }
    let approvals = null;
    try { approvals = readApprovalsBatch?.(current.map(profile => profile.workspaceId)) ?? null; }
    catch { /* Existing single reads retain their normal failure behavior. */ }
    let sessions = null;
    try { sessions = readSessionsBatch?.(current.map(profile => profile.workspaceId)) ?? null; }
    catch { /* Existing single reads retain their normal failure behavior. */ }
    return current.map(profile => projectRow(profile, messages, approvals, sessions));
  }

  function list() {
    return sortBotList(rows().map((row) => row.item));
  }

  function workspacePath(workspaceId) {
    const entry = registry?.get?.(workspaceId);
    return typeof entry?.path === 'string' ? entry.path : '';
  }

  function get(workspaceId) {
    if (!isBotWorkspaceId(workspaceId)) return fail('INVALID_WORKSPACE');
    const profile = profiles.read(workspaceId);
    if (!profile) return fail('NOT_FOUND');
    if (profile.status === 'archived') return fail('ARCHIVED');
    return {
      ok: true,
      item: projectRow(profile).item,
      path: workspacePath(workspaceId),
      profile,
    };
  }

  function readConversation(workspaceId, { limit = 50, before = null, kinds = null, latest = false, presentationOnly = false, processFor = null, view = null } = {}, selectedMessages = null) {
    const profile = profiles.read(workspaceId);
    if (!profile || profile.status === 'archived') return fail('NOT_FOUND');
    if (view === 'cards') {
      try { return { ok: true, cards: readCards(workspaceId) || [] }; }
      catch (error) { return { ok: false, cards: [], code: error?.code || 'CARDS_UNAVAILABLE' }; }
    }
    const allowed = Array.isArray(kinds) ? new Set(kinds.filter((kind) => typeof kind === 'string')) : null;
    if (processFor !== null && (typeof processFor !== 'string' || !processFor.trim() || processFor.length > 500 || presentationOnly)) return fail('INVALID_INPUT');
    const cards = readCards(workspaceId) || [];
    let processMessageId = null;
    let filtered = (selectedMessages || (presentationOnly && typeof readConversationMessages === 'function'
      ? readConversationMessages(profile.agentConversationId) || [] : messagesOf(profile))).filter((message) => {
      if (processFor) return true;
      if (allowed) return allowed.has(messageKind(message));
      // agent_turn stays available so the client can derive disposition marks, then hide the turn.
      return isVisibleBotMessage(message) || messageKind(message) === 'agent_turn';
    });
    if (processFor) {
      const card = cards.find(card => card.cardId === processFor);
      const target = filtered.find(message => message.id === processFor && message.kind !== 'agent_turn')
        || (card?.refs?.turnId ? filtered.find(message => message.turnId === card.refs.turnId && message.card === card.kind) : null)
        || [...filtered].reverse().find(message => message.turnId === processFor && message.kind !== 'agent_turn')
        || filtered.find(message => message.id === processFor);
      let turn = target?.turnId ? filtered.find(message => message.id === target.turnId && message.kind === 'agent_turn') : null;
      if (target?.kind === 'agent_reply' && !target.turnId) for (const message of filtered) {
        if (message.id === target.id) break;
        if (message.kind === 'user_input') turn = null;
        else if (message.kind === 'agent_turn') turn = message;
      }
      filtered = filtered.filter(message => message === target || message === turn);
      processMessageId = target?.id || null;
    }
    const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
    let start = 0;
    let end = filtered.length;
    if (typeof before === 'string' && before) {
      const index = filtered.findIndex((message) => message?.id === before);
      if (latest) end = index >= 0 ? index : filtered.length;
      else start = index >= 0 ? index + 1 : 0;
    }
    if (latest) start = Math.max(0, end - size);
    const byCard = new Map(cards.map((card) => [card.cardId, card]));
    const byReply = new Map();
    for (const card of cards) {
      const replyId = card.refs?.replyMessageId;
      if (typeof replyId !== 'string' || !replyId) continue;
      byReply.set(replyId, [...(byReply.get(replyId) || []), card]);
    }
    const bySession = new Map();
    const currentStates = message => {
      const sources = Array.isArray(message.sources) ? message.sources
        : (Array.isArray(message.meta?.sources) ? message.meta.sources : []);
      return [...new Set(sources.filter(id => typeof id === 'string' && id))].slice(0, 20).flatMap(sessionId => {
        if (!bySession.has(sessionId)) bySession.set(sessionId, getSession(sessionId));
        const session = bySession.get(sessionId);
        return session?.workspaceId === workspaceId ? [{ sessionId, status: session.status, ...(session.sourceRevision ? { sourceRevision: session.sourceRevision } : {}),
          ...(session.observationRevision ? { observationRevision: session.observationRevision } : {}) }] : [];
      });
    };
    const page = filtered.slice(start, latest ? end : start + size).map((message) => ({ ...message,
      ...(message.kind === 'agent_reply' && (message.sources?.length || message.meta?.sessionStates)
        ? { meta: { ...message.meta, sessionStates: currentStates(message) } } : {}),
      ...(message.cards || byReply.has(message.id) ? { cards: [...new Map([
        ...(message.cards || []).map(card => [card.cardId, byCard.get(card.cardId) || card]),
        ...(message.kind === 'agent_reply' ? (byReply.get(message.id) || []).map(card => [card.cardId, card]) : []),
      ]).values()] } : {}),
    }));
    const nextCursor = latest ? (start > 0 ? page[0]?.id ?? null : null)
      : (start + size < filtered.length ? page[page.length - 1]?.id ?? null : null);
    if (!before && !processFor) {
      const present = new Set(filtered.flatMap((message) => (message.cards || []).map((card) => card.cardId)));
      for (const card of cards) if (!card.refs?.replyMessageId && !present.has(card.cardId) && card.resolvedState !== 'resolved') {
        page.push({ id: card.cardId, role: 'assistant', kind: 'system_card', content: '', cards: [card] });
      }
    }
    const familiarizeOffer = !processFor && (before == null || before === '') && !profile.familiarize
      ? FAMILIARIZE_OFFER
      : null;
    return {
      ok: true,
      messages: page,
      nextCursor,
      activeReplyQuestionId: cards.find(card => card.kind === 'question' && card.resolvedState !== 'resolved' && card.refs?.replyMessageId)?.refs.replyMessageId ?? null,
      ...(processFor ? { processMessageId } : {}),
      ...(familiarizeOffer ? { familiarizeOffer } : {}),
    };
  }

  function markRead(workspaceId) {
    const profile = profiles.read(workspaceId);
    if (!profile || profile.status === 'archived') return fail('NOT_FOUND');
    const visible = summaryMessagesOf(profile).filter(isVisibleBotMessage);
    const last = visible.length ? visible[visible.length - 1] : null;
    const current = readCursor(workspaceId);
    const messageId = typeof last?.id === 'string' ? last.id : null;
    const at = (last && messageAt(last)) || (current?.messageId === messageId ? current.at : stamp());
    if (current?.at === at && current.messageId === messageId) {
      return { ok: true, at, messageId, changed: false };
    }
    const dir = runtimeDir(workspaceId);
    mkdirSync(dir, { recursive: true });
    const file = cursorFile(workspaceId);
    const temporary = path.join(dir, `read-cursor.${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify({
      at,
      messageId,
    })}\n`, 'utf8');
    renameSync(temporary, file);
    return { ok: true, at, messageId, changed: true };
  }

  function query(value) {
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    const built = rows();
    const catalog = sortBotList(built.map((row) => row.item));
    if (!text) return { items: catalog, catalog };
    const matched = built.filter((row) => {
      if (row.item.profile.displayName.toLowerCase().includes(text)) return true;
      if (row.item.preview.toLowerCase().includes(text)) return true;
      return row.titles.some((title) => title.toLowerCase().includes(text));
    });
    return { items: sortBotList(matched.map((row) => row.item)), catalog };
  }

  return {
    list,
    attention: workspaceId => {
      if (workspaceId) {
        const profile = profiles.read(workspaceId);
        return profile && profile.status !== 'archived' ? projectRow(profile).attention : [];
      }
      return rows().flatMap(row => row.attention);
    },
    questionState: (workspaceId, messageId) => {
      const profile = profiles.read(workspaceId);
      return profile && profile.status !== 'archived'
        ? projectReplyQuestions(summaryMessagesOf(profile), Date.parse(stamp())).get(messageId)?.state : undefined;
    },
    get,
    readConversation,
    async readProcess(workspaceId, params = {}) {
      const profile = profiles.read(workspaceId);
      if (!profile || profile.status === 'archived') return fail('NOT_FOUND');
      if (typeof params.processFor !== 'string' || !params.processFor.trim() || params.processFor.length > 500 || params.presentationOnly) return fail('INVALID_INPUT');
      if (typeof readInteractionProcess !== 'function') return readConversation(workspaceId, params);
      const card = (readCards(workspaceId) || []).find(card => card.cardId === params.processFor);
      const page = await readInteractionProcess(profile.agentConversationId, { messageId: params.processFor, turnId: card?.refs?.turnId });
      return page ? readConversation(workspaceId, params, page.messages) : fail('NOT_FOUND');
    },
    async readInteractions(workspaceId, { limit = 50, before = null } = {}) {
      const profile = profiles.read(workspaceId);
      if (!profile || profile.status === 'archived') return fail('NOT_FOUND');
      if (typeof readInteractionPage !== 'function') return readConversation(workspaceId, { limit, before, latest: true, presentationOnly: true });
      const page = await readInteractionPage(profile.agentConversationId, { limit, ...(before ? { before } : {}) });
      return page ? { ok: true, messages: page.messages, nextCursor: page.nextCursor, sourceVersion: page.sourceVersion,
        ...(!before && !profile.familiarize ? { familiarizeOffer: FAMILIARIZE_OFFER } : {}) } : fail('NOT_FOUND');
    },
    listSessions: (workspaceId) => sessionsOf(workspaceId),
    getSession: (sessionId) => getSession(sessionId),
    listApprovals: (workspaceId) => {
      const approvals = listApprovals(workspaceId);
      return Array.isArray(approvals) ? approvals : [];
    },
    markRead,
    query,
    search: (value) => query(value).items,
    conversationId: (workspaceId) => profiles.read(workspaceId)?.agentConversationId || '',
    workspaceIds: () => activeProfiles().map((profile) => profile.workspaceId),
  };
}
