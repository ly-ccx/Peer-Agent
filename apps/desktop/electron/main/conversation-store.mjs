import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathOf } from './data-store.mjs';

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function writeJsonl(filePath, rows) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

function appendJsonl(filePath, row) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function normalizeMode(value) {
  return value === 'goal' ? 'goal' : 'chat';
}

function normalizeStatus(value) {
  return value === 'archived' ? 'archived' : 'active';
}

function normalizeStatuses(status) {
  if (Array.isArray(status)) return new Set(status.map(normalizeStatus));
  if (typeof status === 'string') return new Set([normalizeStatus(status)]);
  return null;
}

function normalizeMeta(meta) {
  return {
    ...meta,
    mode: normalizeMode(meta?.mode),
    status: normalizeStatus(meta?.status),
    archivedAt: normalizeStatus(meta?.status) === 'archived' ? (meta?.archivedAt || meta?.updatedAt || meta?.createdAt || null) : null,
  };
}

export function createConversationStore({ storeDir = pathOf('conversations') } = {}) {
  const indexFile = path.join(storeDir, 'index.jsonl');

  function convFile(id) { return path.join(storeDir, `${id}.jsonl`); }

  function readIndex() { return readJsonl(indexFile).map(normalizeMeta); }

  function listConversations(params = {}) {
    const statuses = normalizeStatuses(params?.status);
    return readIndex()
      .filter((meta) => !statuses || statuses.has(normalizeStatus(meta.status)))
      .map((meta) => {
        const msgs = existsSync(convFile(meta.id)) ? readJsonl(convFile(meta.id)) : [];
        return { ...meta, messageCount: msgs.length };
      })
      // 按「最近修改」降序：updatedAt 每次写操作（消息追加 / 改标题 / 改模式 / 计费）都会刷新，
      // 因此最近活跃的对话冒泡到顶部；极旧数据若缺 updatedAt 则回退到 createdAt 兜底。
      .sort((a, b) => {
        const keyOf = (m) => String(m.updatedAt || m.createdAt || '');
        return keyOf(b).localeCompare(keyOf(a));
      });
  }

  function listConversationsByWorkspace(workspacePath, params = {}) {
    return listConversations(params).filter((c) => (c.workspacePath || null) === (workspacePath || null));
  }

  // 对话模式（chat / goal）按会话持久化在会话 meta 上，而非全局设置：
  // 模式是「每会话状态」，与计划数据同口径，切换会话各自独立、互不影响。
  function createConversation({ title, workspacePath, mode } = {}) {
    const now = new Date().toISOString();
    const meta = {
      id: randomUUID(),
      title: title || '',
      workspacePath: workspacePath || null,
      mode: normalizeMode(mode),
      status: 'active',
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    appendJsonl(indexFile, meta);
    return { ...meta, messageCount: 0 };
  }

  function updateMode(id, mode) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    meta.mode = normalizeMode(mode);
    meta.updatedAt = new Date().toISOString();
    writeJsonl(indexFile, index);
    const msgs = existsSync(convFile(id)) ? readJsonl(convFile(id)) : [];
    return { ...meta, messageCount: msgs.length };
  }

  function getConversation(id) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    const messages = readJsonl(convFile(id));
    return { ...meta, messages };
  }

  function updateTitle(id, title) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    meta.title = title;
    meta.updatedAt = new Date().toISOString();
    writeJsonl(indexFile, index);
    const msgs = existsSync(convFile(id)) ? readJsonl(convFile(id)) : [];
    return { ...meta, messageCount: msgs.length };
  }

  function appendMessage(id, message) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    appendJsonl(convFile(id), message);
    if (!meta.title && message.role === 'user') {
      meta.title = message.content.slice(0, 50);
    }
    meta.updatedAt = new Date().toISOString();
    writeJsonl(indexFile, index);
    return { ...meta, messages: readJsonl(convFile(id)) };
  }

  function updateLastMessage(id, content) {
    const messages = readJsonl(convFile(id));
    if (!messages.length) return null;
    messages[messages.length - 1].content = content;
    writeJsonl(convFile(id), messages);
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (meta) { meta.updatedAt = new Date().toISOString(); writeJsonl(indexFile, index); }
    return meta ? { ...meta, messages } : null;
  }

  function replaceMessages(id, newMessages) {
    writeJsonl(convFile(id), newMessages);
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (meta) { meta.updatedAt = new Date().toISOString(); writeJsonl(indexFile, index); }
    return meta ? { ...meta, messages: newMessages } : null;
  }

  // 会话级累计用量账本。独立挂在 index meta 上（不在消息 jsonl 里），
  // 因此压缩（replaceMessages 仅重写消息文件）不会触及它 —— 这是修复
  // "压缩后右下角计费被清零" 的核心：累计 usage 不再依附于会被删除的消息。
  // 见 docs/architecture/23-session-usage-ledger.md。
  function addUsage(id, usage) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    // 字段统一用 *Tokens 命名,与契约 LifetimeUsage / renderer 读写口径一致(ADR 23)。
    const prev = meta.lifetimeUsage || {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    };
    meta.lifetimeUsage = {
      inputTokens: (prev.inputTokens || 0) + (usage?.inputTokens || 0),
      outputTokens: (prev.outputTokens || 0) + (usage?.outputTokens || 0),
      cacheWriteTokens: (prev.cacheWriteTokens || 0) + (usage?.cacheWriteTokens || 0),
      cacheReadTokens: (prev.cacheReadTokens || 0) + (usage?.cacheReadTokens || 0),
    };
    meta.updatedAt = new Date().toISOString();
    writeJsonl(indexFile, index);
    return meta.lifetimeUsage;
  }

  function setArchiveStatus(id, status) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    const nextStatus = normalizeStatus(status);
    const now = new Date().toISOString();
    meta.status = nextStatus;
    meta.archivedAt = nextStatus === 'archived' ? now : null;
    meta.updatedAt = now;
    writeJsonl(indexFile, index);
    const msgs = existsSync(convFile(id)) ? readJsonl(convFile(id)) : [];
    return { ...meta, messageCount: msgs.length };
  }

  function archiveConversation(id) {
    return setArchiveStatus(id, 'archived');
  }

  function restoreConversation(id) {
    return setArchiveStatus(id, 'active');
  }

  function autoArchiveConversations({ before, excludeIds = [] } = {}) {
    const cutoff = before ? Date.parse(before) : Number.NaN;
    if (!Number.isFinite(cutoff)) return { archivedIds: [], archivedCount: 0 };
    const excluded = new Set(Array.isArray(excludeIds) ? excludeIds.filter(Boolean) : []);
    const index = readIndex();
    const now = new Date().toISOString();
    const archivedIds = [];
    for (const meta of index) {
      if (normalizeStatus(meta.status) !== 'active') continue;
      if (excluded.has(meta.id)) continue;
      const updatedMs = Date.parse(meta.updatedAt || meta.createdAt || '');
      if (!Number.isFinite(updatedMs) || updatedMs >= cutoff) continue;
      meta.status = 'archived';
      meta.archivedAt = now;
      meta.updatedAt = now;
      archivedIds.push(meta.id);
    }
    if (archivedIds.length) writeJsonl(indexFile, index);
    return { archivedIds, archivedCount: archivedIds.length };
  }

  function deleteConversation(id) {
    const index = readIndex().filter((c) => c.id !== id);
    writeJsonl(indexFile, index);
    try { if (existsSync(convFile(id))) unlinkSync(convFile(id)); } catch {}
    return index.map((meta) => {
      const msgs = existsSync(convFile(meta.id)) ? readJsonl(convFile(meta.id)) : [];
      return { ...meta, messageCount: msgs.length };
    });
  }

  // 一次性迁移：如果旧 conversations.json 存在，转成 JSONL 格式
  const legacyFile = path.join(path.dirname(storeDir), 'conversations.json');
  if (existsSync(legacyFile) && !existsSync(indexFile)) {
    try {
      const legacy = JSON.parse(readFileSync(legacyFile, 'utf8'));
      if (Array.isArray(legacy)) {
        mkdirSync(storeDir, { recursive: true });
        for (const conv of legacy) {
          const { messages, ...meta } = conv;
          appendJsonl(indexFile, normalizeMeta(meta));
          if (messages?.length) writeJsonl(convFile(meta.id), messages);
        }
        console.log(`[conversation-store] migrated ${legacy.length} conversations from JSON to JSONL`);
      }
    } catch (err) {
      console.warn('[conversation-store] migration failed:', err?.message);
    }
  }

  return {
    listConversations,
    listConversationsByWorkspace,
    createConversation,
    getConversation,
    updateTitle,
    updateMode,
    appendMessage,
    updateLastMessage,
    replaceMessages,
    addUsage,
    archiveConversation,
    restoreConversation,
    autoArchiveConversations,
    deleteConversation,
  };
}
