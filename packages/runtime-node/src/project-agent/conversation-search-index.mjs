/**
 * 项目代理搜索索引。覆盖机器人、可见消息、任务标题和记忆。
 * 增量更新与从同一批源数据重建的结果一致。
 */
import { isVisibleBotMessage } from './bot-directory.mjs';

const KINDS = new Set(['bot', 'message', 'task', 'memory']);
const DEFAULT_LIMIT = 50;

function textOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value?.content === 'string') return value.content;
  if (typeof value?.text === 'string') return value.text;
  return '';
}

function clip(value, max = 80) {
  return Array.from(String(value ?? '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

function normalize(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const id = typeof doc.id === 'string' ? doc.id.trim() : '';
  const kind = doc.kind;
  const workspaceId = typeof doc.workspaceId === 'string' ? doc.workspaceId : '';
  if (!id || !KINDS.has(kind)) return null;
  const title = typeof doc.title === 'string' ? doc.title : '';
  const text = typeof doc.text === 'string' ? doc.text : '';
  const haystack = `${title}\n${text}`.toLowerCase();
  return {
    id,
    kind,
    workspaceId,
    title,
    text,
    haystack,
    messageId: typeof doc.messageId === 'string' ? doc.messageId : '',
    sessionId: typeof doc.sessionId === 'string' ? doc.sessionId : '',
    memoryId: typeof doc.memoryId === 'string' ? doc.memoryId : '',
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : '',
  };
}

function hitOf(doc) {
  return {
    id: doc.id,
    kind: doc.kind,
    workspaceId: doc.workspaceId,
    title: doc.title,
    text: doc.text,
    ...(doc.messageId ? { messageId: doc.messageId } : {}),
    ...(doc.sessionId ? { sessionId: doc.sessionId } : {}),
    ...(doc.memoryId ? { memoryId: doc.memoryId } : {}),
    updatedAt: doc.updatedAt,
  };
}

function scoreOf(doc, query) {
  if (!query) return 0;
  const title = doc.title.toLowerCase();
  if (title === query) return 300;
  if (title.startsWith(query)) return 200;
  if (title.includes(query)) return 100;
  if (doc.haystack.includes(query)) return 50;
  return -1;
}

/**
 * @param {{ bots?: object[], messages?: { workspaceId: string, message: object }[], tasks?: object[], memories?: object[] }} [sources]
 */
export function collectConversationSearchDocuments({
  bots = [],
  messages = [],
  tasks = [],
  memories = [],
} = {}) {
  const docs = [];
  for (const bot of Array.isArray(bots) ? bots : []) {
    const workspaceId = typeof bot?.workspaceId === 'string' ? bot.workspaceId : '';
    if (!workspaceId) continue;
    const title = bot?.profile?.displayName || workspaceId;
    docs.push({
      id: `bot:${workspaceId}`,
      kind: 'bot',
      workspaceId,
      title,
      text: typeof bot?.preview === 'string' ? bot.preview : '',
      updatedAt: typeof bot?.lastActiveAt === 'string' ? bot.lastActiveAt : '',
    });
  }
  for (const entry of Array.isArray(messages) ? messages : []) {
    const message = entry?.message;
    const workspaceId = typeof entry?.workspaceId === 'string' ? entry.workspaceId : '';
    const messageId = typeof message?.id === 'string' ? message.id : '';
    if (!workspaceId || !messageId || !isVisibleBotMessage(message)) continue;
    const text = textOf(message).trim();
    if (!text) continue;
    docs.push({
      id: `message:${workspaceId}:${messageId}`,
      kind: 'message',
      workspaceId,
      title: clip(text),
      text,
      messageId,
      updatedAt: typeof message?.createdAt === 'string' ? message.createdAt : '',
    });
  }
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const workspaceId = typeof task?.workspaceId === 'string' ? task.workspaceId : '';
    const sessionId = typeof task?.sessionId === 'string' ? task.sessionId : '';
    const title = typeof task?.title === 'string' ? task.title.trim() : '';
    if (!workspaceId || !sessionId || !title) continue;
    docs.push({
      id: `task:${workspaceId}:${sessionId}`,
      kind: 'task',
      workspaceId,
      title,
      text: title,
      sessionId,
      updatedAt: typeof task?.updatedAt === 'string' ? task.updatedAt : '',
    });
  }
  for (const memory of Array.isArray(memories) ? memories : []) {
    if (memory?.status && memory.status !== 'active') continue;
    const memoryId = typeof memory?.id === 'string' ? memory.id : '';
    const text = typeof memory?.text === 'string' ? memory.text.trim() : '';
    if (!memoryId || !text) continue;
    docs.push({
      id: `memory:${memoryId}`,
      kind: 'memory',
      workspaceId: typeof memory?.workspaceId === 'string' ? memory.workspaceId : '',
      title: clip(text),
      text,
      memoryId,
      updatedAt: typeof memory?.updatedAt === 'string'
        ? memory.updatedAt
        : (typeof memory?.createdAt === 'string' ? memory.createdAt : ''),
    });
  }
  return docs;
}

export function createConversationSearchIndex() {
  const docs = new Map();

  function upsert(doc) {
    const normalized = normalize(doc);
    if (!normalized) return false;
    docs.set(normalized.id, normalized);
    return true;
  }

  function remove(id) {
    return docs.delete(id);
  }

  function rebuild(source) {
    docs.clear();
    for (const doc of Array.isArray(source) ? source : []) upsert(doc);
  }

  function sync(source) {
    const next = new Set();
    for (const doc of Array.isArray(source) ? source : []) {
      if (upsert(doc)) next.add(normalize(doc).id);
    }
    for (const id of [...docs.keys()]) {
      if (!next.has(id)) docs.delete(id);
    }
  }

  function search(query, { limit = DEFAULT_LIMIT } = {}) {
    const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const cap = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
    const hits = [];
    for (const doc of docs.values()) {
      const score = scoreOf(doc, q);
      if (score < 0) continue;
      hits.push({ score, doc });
    }
    hits.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const byTime = String(right.doc.updatedAt).localeCompare(String(left.doc.updatedAt));
      if (byTime !== 0) return byTime;
      return left.doc.id.localeCompare(right.doc.id);
    });
    return hits.slice(0, cap).map((entry) => hitOf(entry.doc));
  }

  return {
    upsert,
    remove,
    rebuild,
    sync,
    search,
    size: () => docs.size,
  };
}
