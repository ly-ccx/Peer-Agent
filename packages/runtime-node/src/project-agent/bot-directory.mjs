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
  return { role, text: clip(messageText(message)), at: messageAt(message) };
}

function questionsIn(messages) {
  const found = [];
  for (const message of messages) {
    const question = message?.question;
    if (!question || typeof question !== 'object' || question.answered === true) continue;
    found.push(question);
  }
  return found;
}

export function createBotDirectory({
  rootDir = null,
  registry = null,
  readMessages = () => [],
  listSessions = () => [],
  getSession = () => null,
  listApprovals = () => [],
  listConfirmations = () => [],
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
      return typeof parsed?.at === 'string' && parsed.at ? parsed.at : null;
    } catch {
      return null;
    }
  }

  function sessionsOf(workspaceId) {
    const sessions = listSessions(workspaceId);
    return Array.isArray(sessions) ? sessions : [];
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
    const mappedSessions = [
      ...sessions.map((session) => ({
        status: session?.status,
        updatedAt: session?.updatedAt,
      })),
      ...questions.map(() => ({ status: 'waiting_user' })),
      ...openConfirmations.map(() => ({ status: 'waiting_user' })),
    ];
    const approvals = listApprovals(profile.workspaceId);
    return {
      item: projectBotListItem({
        profile: {
          workspaceId: profile.workspaceId,
          displayName: profile.displayName,
          avatar: profile.avatar,
          managed: profile.managed === true,
          agentConversationId: profile.agentConversationId,
          updatedAt: profile.updatedAt,
        },
        lastMessage: last,
        sessions: mappedSessions,
        approvals: Array.isArray(approvals) ? approvals : [],
        readCursor: readCursor(profile.workspaceId),
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

  function readConversation(workspaceId, { limit = 50, before = null, kinds = null } = {}) {
    const profile = profiles.read(workspaceId);
    if (!profile || profile.status === 'archived') return fail('NOT_FOUND');
    const allowed = Array.isArray(kinds) ? new Set(kinds.filter((kind) => typeof kind === 'string')) : null;
    const filtered = messagesOf(profile).filter((message) => {
      if (!allowed) return isVisibleBotMessage(message);
      return allowed.has(messageKind(message));
    });
    const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
    let start = 0;
    if (typeof before === 'string' && before) {
      const index = filtered.findIndex((message) => message?.id === before);
      start = index >= 0 ? index + 1 : 0;
    }
    const page = filtered.slice(start, start + size);
    const nextCursor = start + size < filtered.length ? (page[page.length - 1]?.id ?? null) : null;
    return { ok: true, messages: page, nextCursor };
  }

  function markRead(workspaceId) {
    const profile = profiles.read(workspaceId);
    if (!profile || profile.status === 'archived') return fail('NOT_FOUND');
    const visible = messagesOf(profile).filter(isVisibleBotMessage);
    const last = visible.length ? visible[visible.length - 1] : null;
    const at = last ? (messageAt(last) || stamp()) : stamp();
    const dir = runtimeDir(workspaceId);
    mkdirSync(dir, { recursive: true });
    const file = cursorFile(workspaceId);
    const temporary = path.join(dir, `read-cursor.${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify({
      at,
      messageId: typeof last?.id === 'string' ? last.id : null,
    })}\n`, 'utf8');
    renameSync(temporary, file);
    return { ok: true, at, messageId: typeof last?.id === 'string' ? last.id : null };
  }

  function search(query) {
    const text = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const built = rows();
    if (!text) return sortBotList(built.map((row) => row.item));
    const matched = built.filter((row) => {
      if (row.item.profile.displayName.toLowerCase().includes(text)) return true;
      if (row.item.preview.toLowerCase().includes(text)) return true;
      return row.titles.some((title) => title.toLowerCase().includes(text));
    });
    return sortBotList(matched.map((row) => row.item));
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
    search,
    conversationId: (workspaceId) => profiles.read(workspaceId)?.agentConversationId || '',
    workspaceIds: () => activeProfiles().map((profile) => profile.workspaceId),
  };
}
