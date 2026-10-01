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

const VISIBLE_KINDS = new Set(['user_input', 'agent_reply', 'system_card']);
const PREVIEW_MAX = 80;

function fail(code) {
  return { ok: false, code };
}

function clip(value) {
  return Array.from(String(value ?? '').replace(/\s+/g, ' ').trim()).slice(0, PREVIEW_MAX).join('');
}

function messageKind(message) {
  const kind = message?.kind || message?.type || message?.messageKind;
  return typeof kind === 'string' ? kind : '';
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (typeof message?.text === 'string') return message.text;
  return '';
}

function messageAt(message) {
  if (typeof message?.createdAt === 'string' && message.createdAt) return message.createdAt;
  if (typeof message?.at === 'string' && message.at) return message.at;
  return '';
}

export function isVisibleBotMessage(message) {
  const kind = messageKind(message);
  if (VISIBLE_KINDS.has(kind)) return true;
  if (!kind && (message?.role === 'user' || message?.role === 'assistant')) return true;
  return false;
}

function toListMessage(message) {
  const kind = messageKind(message);
  const role = kind === 'user_input' || message?.role === 'user' ? 'user' : 'assistant';
  const surfacing = message?.meta?.surfacing || message?.surfacing;
  return {
    role,
    text: clip(messageText(message)),
    at: messageAt(message),
    ...(surfacing === 'silent' || message?.meta?.unread === false ? { countUnread: false } : {}),
  };
}

function questionsIn(messages) {
  const found = [];
  for (const message of messages) {
    const question = message?.question;
    if (!question || typeof question !== 'object' || question.answered === true) continue;
    if (messages.some(answer => answer.answerTo === `card:question:reply:${message.id}`)) continue;
    found.push(question);
  }
  return found;
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
  listSessions = () => [],
  getSession = () => null,
  listApprovals = () => [],
  listConfirmations = () => [],
  listClassicGoals = () => [],
  readCards = () => [],
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

  function messagesOf(profile) {
    if (!profile?.agentConversationId || typeof readMessages !== 'function') return [];
    const messages = readMessages(profile.agentConversationId, profile.workspaceId);
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

  function sessionsOf(workspaceId) {
    const sessions = listSessions(workspaceId);
    return Array.isArray(sessions) ? sessions : [];
  }

  function classicGoalsOf(workspaceId) {
    if (typeof listClassicGoals !== 'function') return [];
    try {
      const goals = listClassicGoals(workspaceId);
      return Array.isArray(goals) ? goals : [];
    } catch {
      return [];
    }
  }

  function projectRow(profile) {
    const messages = messagesOf(profile);
    const visible = messages.filter(isVisibleBotMessage);
    const last = visible.length ? toListMessage(visible[visible.length - 1]) : null;
    const sessions = sessionsOf(profile.workspaceId);
    const questions = questionsIn(messages);
    const confirmations = listConfirmations(profile.workspaceId);
    const openConfirmations = (Array.isArray(confirmations) ? confirmations : [])
      .filter((item) => item && item.accepted !== true && item.needsConfirm !== false);
    const classicGoals = classicGoalsOf(profile.workspaceId);
    const mappedSessions = [
      ...sessions.map((session) => ({
        status: session?.status,
        updatedAt: session?.updatedAt,
      })),
      ...questions.map(() => ({ status: 'waiting_user' })),
      ...openConfirmations.map(() => ({ status: 'waiting_user' })),
      ...classicGoals
        .filter((goal) => goal?.waitingUser === true)
        .map((goal) => ({ status: 'waiting_user', updatedAt: goal.updatedAt })),
    ];
    const approvals = listApprovals(profile.workspaceId);
    return {
      item: projectBotListItem({
        profile: { ...profile },
        lastMessage: last,
        sessions: mappedSessions,
        approvals: Array.isArray(approvals) ? approvals : [],
        readCursor: readCursor(profile.workspaceId)?.at ?? null,
      }),
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
    return activeProfiles().map(projectRow);
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

  function readConversation(workspaceId, { limit = 50, before = null, kinds = null, latest = false } = {}) {
    const profile = profiles.read(workspaceId);
    if (!profile || profile.status === 'archived') return fail('NOT_FOUND');
    const allowed = Array.isArray(kinds) ? new Set(kinds.filter((kind) => typeof kind === 'string')) : null;
    const filtered = messagesOf(profile).filter((message) => {
      if (allowed) return allowed.has(messageKind(message));
      // agent_turn stays available so the client can derive disposition marks, then hide the turn.
      return isVisibleBotMessage(message) || messageKind(message) === 'agent_turn';
    });
    const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
    let start = 0;
    let end = filtered.length;
    if (typeof before === 'string' && before) {
      const index = filtered.findIndex((message) => message?.id === before);
      if (latest) end = index >= 0 ? index : filtered.length;
      else start = index >= 0 ? index + 1 : 0;
    }
    if (latest) start = Math.max(0, end - size);
    const cards = readCards(workspaceId) || [];
    const byCard = new Map(cards.map((card) => [card.cardId, card]));
    const bySession = new Map();
    const currentStates = message => {
      const sources = Array.isArray(message.sources) ? message.sources
        : (Array.isArray(message.meta?.sources) ? message.meta.sources : []);
      return [...new Set(sources.filter(id => typeof id === 'string' && id))].slice(0, 20).flatMap(sessionId => {
        if (!bySession.has(sessionId)) bySession.set(sessionId, getSession(sessionId));
        const session = bySession.get(sessionId);
        return session?.workspaceId === workspaceId ? [{ sessionId, status: session.status }] : [];
      });
    };
    const page = filtered.slice(start, latest ? end : start + size).map((message) => ({ ...message,
      ...(message.kind === 'agent_reply' && (message.sources?.length || message.meta?.sessionStates)
        ? { meta: { ...message.meta, sessionStates: currentStates(message) } } : {}),
      ...(message.cards ? { cards: message.cards.map((card) => byCard.get(card.cardId) || card) } : {}),
    }));
    const nextCursor = latest ? (start > 0 ? page[0]?.id ?? null : null)
      : (start + size < filtered.length ? page[page.length - 1]?.id ?? null : null);
    if (!before) {
      const present = new Set(filtered.flatMap((message) => (message.cards || []).map((card) => card.cardId)));
      for (const card of cards) if (!present.has(card.cardId) && card.resolvedState !== 'resolved') {
        page.push({ id: card.cardId, role: 'assistant', kind: 'system_card', content: '', cards: [card] });
      }
    }
    const familiarizeOffer = (before == null || before === '') && !profile.familiarize
      ? FAMILIARIZE_OFFER
      : null;
    return {
      ok: true,
      messages: page,
      nextCursor,
      ...(familiarizeOffer ? { familiarizeOffer } : {}),
    };
  }

  function markRead(workspaceId) {
    const profile = profiles.read(workspaceId);
    if (!profile || profile.status === 'archived') return fail('NOT_FOUND');
    const visible = messagesOf(profile).filter(isVisibleBotMessage);
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
    get,
    readConversation,
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
