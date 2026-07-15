import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

function defaultStoreDir() {
  const dataHome = process.env.PEER_AGENT_HOME || process.env.PEER_USER_DATA_PATH || path.join(os.homedir(), '.peer-agent');
  return path.join(dataHome, 'conversations');
}

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

function withFileLock(filePath, operation) {
  const lockDir = `${filePath}.lock`;
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST' || Date.now() >= deadline) throw error;
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

// 对话模式归一化。wire 值迁移后（见 ADR 41 / goal-mode-ultrathink-workflow 设计文档）:
// 'plan' = 审批门模式;'goal' = 自驱目标模式。存量会话里历史的 'goal'（旧 plan 语义）
// 已由 store 初始化时的一次性数据迁移（migrateLegacyGoalMode）改写为 'plan',因此这里
// 不再把 'goal' 兼容映射为 'plan',而是按新的自驱语义原样保留。
function normalizeMode(value) {
  if (value === 'plan') return 'plan';
  if (value === 'goal') return 'goal';
  return 'chat';
}

// 思考强度（reasoning effort）归一化。与前端 preferences.ts 的 EffortLevel 集合对齐：
// off / low / default / high / xhigh / max。非法或缺失值回落 'default'，确保老会话无该字段时
// 取全局默认档位，不会把脏值带到 provider 请求里。
const VALID_EFFORT_LEVELS = new Set(['off', 'low', 'default', 'high', 'xhigh', 'max']);
function normalizeEffort(value) {
  return VALID_EFFORT_LEVELS.has(value) ? value : 'default';
}

// 会话绑定的模型 provider id 归一化。provider 是打平的 provider×model 组合（复合 id，
// 形如 groupId::modelId）。这里只做存在性与类型校验，不校验该 provider 是否仍可用——
// 可用性校验在发送时由 orderProviderCandidates 按首选优先 + 故障转移处理，删除 provider
// 后会话里残留的 modelProviderId 会自动回退到全局默认 provider（强绑定校验）。
function normalizeModelProviderId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
  const status = normalizeStatus(meta?.status);
  const pinnedAt = typeof meta?.pinnedAt === 'string' && meta.pinnedAt.trim() ? meta.pinnedAt : null;
  const pinnedOrder = pinnedAt && Number.isFinite(Number(meta?.pinnedOrder)) ? Number(meta.pinnedOrder) : null;
  return {
    ...meta,
    mode: normalizeMode(meta?.mode),
    effort: normalizeEffort(meta?.effort),
    modelProviderId: normalizeModelProviderId(meta?.modelProviderId),
    status,
    archivedAt: status === 'archived' ? (meta?.archivedAt || meta?.updatedAt || meta?.createdAt || null) : null,
    pinnedAt,
    pinnedOrder,
  };
}

// 一次性数据迁移（wire 值迁移，见 ADR 41 / goal-mode-ultrathink-workflow 设计文档）:
// 把存量会话 index 里历史的 mode==='goal'（旧 plan 语义）改写为 'plan'。
//
// 为何必须直接读写原始 index、绕过 normalizeMode:撤销兼容映射后,normalizeMode 会把
// 'goal' 当作新的自驱语义,若先经 normalizeMeta 再迁移就无法区分「历史旧 plan 语义的
// goal」与「用户新建的自驱 goal」。故此迁移读原始行、按字面量 'goal' 改写,并写入
// marker 文件确保只跑一次;marker 存在后新建的 'goal' 会话不会再被回写。
function migrateLegacyGoalMode(storeDir, indexFile) {
  try {
    const markerFile = path.join(storeDir, '.goal-to-plan-migrated');
    if (existsSync(markerFile)) return;
    if (existsSync(indexFile)) {
      const rows = readJsonl(indexFile);
      let changed = false;
      for (const row of rows) {
        if (row && row.mode === 'goal') { row.mode = 'plan'; changed = true; }
      }
      if (changed) writeJsonl(indexFile, rows);
    }
    if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
    writeFileSync(markerFile, new Date().toISOString(), 'utf8');
  } catch {
    // 迁移失败不应阻断 store 初始化;下次启动 marker 不存在会重试。
  }
}

export function createConversationStore({ storeDir = defaultStoreDir() } = {}) {
  const indexFile = path.join(storeDir, 'index.jsonl');

  // 撤销 'goal'→'plan' 兼容映射前,先对存量数据做一次性迁移,避免历史 'goal' 被误判为自驱语义。
  migrateLegacyGoalMode(storeDir, indexFile);

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

  // 对话模式（chat / plan）按会话持久化在会话 meta 上，而非全局设置：
  // 模式是「每会话状态」，与计划数据同口径，切换会话各自独立、互不影响。
  function createConversation({ title, workspacePath, mode } = {}) {
    const now = new Date().toISOString();
    const meta = {
      id: randomUUID(),
      title: title || '',
      workspacePath: workspacePath || null,
      mode: normalizeMode(mode),
      // 会话级模型 + 思考模式绑定的初值（与 mode 同口径持久化）。默认 effort='default'、
      // modelProviderId=null（未绑定 → 发送时用全局默认 provider）。写入落盘 meta 使
      // createConversation 返回值与 getConversation（经 normalizeMeta）保持一致。
      effort: 'default',
      modelProviderId: null,
      status: 'active',
      archivedAt: null,
      pinnedAt: null,
      pinnedOrder: null,
      createdAt: now,
      updatedAt: now,
    };
    withFileLock(indexFile, () => appendJsonl(indexFile, meta));
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

  // 会话级模型 + 思考模式绑定（随会话持久化，同 mode 范式）。两者各自独立写入，互不影响：
  // 用户可只切模型不切思考档，或反之。modelProviderId 为 null 表示回退到全局默认 provider。
  // 强绑定校验不在存储层做——发送时 orderProviderCandidates 会校验首选 provider 是否仍可用，
  // 不可用则自动回退；这里只负责如实存取用户的选择。
  function updateModelEffort(id, { effort, modelProviderId } = {}) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    if (effort !== undefined) meta.effort = normalizeEffort(effort);
    if (modelProviderId !== undefined) meta.modelProviderId = normalizeModelProviderId(modelProviderId);
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
    return withFileLock(indexFile, () => {
      const index = readIndex();
      const meta = index.find((c) => c.id === id);
      if (!meta) return null;
      withFileLock(convFile(id), () => appendJsonl(convFile(id), message));
      if (!meta.title && message.role === 'user') {
        meta.title = message.content.slice(0, 50);
      }
      meta.updatedAt = new Date().toISOString();
      writeJsonl(indexFile, index);
      return { ...meta, messages: readJsonl(convFile(id)) };
    });
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

  /**
   * 按消息 id 局部更新一条消息（浅合并 patch）。这是「助手正文持久化真值下沉主进程」
   * 的落盘原语：主进程在流式累积/终结时，用 streamRecord 的 content/segments/usage/
   * interrupted 直接 patch 对应 assistant 消息，无需 renderer 在终态事件回写。
   *
   * 定位策略：先按 messageId 精确匹配；未命中时回退到「最后一条 assistant 消息」——
   * 覆盖 regenerate 路径（renderer 新建了 newAssistant.id，但 store 侧仍是 updateLastMessage
   * 置空的旧 last-message id）。两者都不存在时返回 null（不静默新建，避免脏写）。
   */
  function updateMessageById(id, messageId, patch) {
    if (!patch || typeof patch !== 'object') return null;
    const messages = readJsonl(convFile(id));
    if (!messages.length) return null;
    let targetIndex = messageId ? messages.findIndex((m) => m && m.id === messageId) : -1;
    if (targetIndex < 0) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i] && messages[i].role === 'assistant') { targetIndex = i; break; }
      }
    }
    if (targetIndex < 0) return null;
    messages[targetIndex] = { ...messages[targetIndex], ...patch };
    writeJsonl(convFile(id), messages);
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (meta) { meta.updatedAt = new Date().toISOString(); writeJsonl(indexFile, index); }
    return meta ? { ...meta, messages } : null;
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
    if (nextStatus === 'archived') {
      meta.pinnedAt = null;
      meta.pinnedOrder = null;
    }
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

  function getPinnedOrderSeed(index) {
    const orders = index
      .filter((meta) => meta.pinnedAt && meta.pinnedOrder !== null && meta.pinnedOrder !== undefined)
      .map((meta) => Number(meta.pinnedOrder))
      .filter((order) => Number.isFinite(order));
    return orders.length ? Math.min(...orders) - 1 : 0;
  }

  function withMessageCount(meta) {
    const msgs = existsSync(convFile(meta.id)) ? readJsonl(convFile(meta.id)) : [];
    return { ...meta, messageCount: msgs.length };
  }

  function pinConversation(id) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    if (normalizeStatus(meta.status) === 'archived') return withMessageCount(meta);
    const now = new Date().toISOString();
    if (!meta.pinnedAt) {
      meta.pinnedAt = now;
      meta.pinnedOrder = getPinnedOrderSeed(index);
    }
    meta.updatedAt = now;
    writeJsonl(indexFile, index);
    return withMessageCount(meta);
  }

  function unpinConversation(id) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    const now = new Date().toISOString();
    meta.pinnedAt = null;
    meta.pinnedOrder = null;
    meta.updatedAt = now;
    writeJsonl(indexFile, index);
    return withMessageCount(meta);
  }

  function reorderPinnedConversations(ids = []) {
    const orderedIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
    const index = readIndex();
    const pinned = index
      .filter((meta) => meta.pinnedAt && normalizeStatus(meta.status) === 'active')
      .sort((a, b) => Number(a.pinnedOrder ?? 0) - Number(b.pinnedOrder ?? 0));
    const pinnedIds = new Set(pinned.map((meta) => meta.id));
    const nextIds = [
      ...orderedIds.filter((id) => pinnedIds.has(id)),
      ...pinned.map((meta) => meta.id).filter((id) => !orderedIds.includes(id)),
    ];
    const orderById = new Map(nextIds.map((id, index) => [id, index]));
    for (const meta of index) {
      if (orderById.has(meta.id)) meta.pinnedOrder = orderById.get(meta.id);
    }
    writeJsonl(indexFile, index);
    return listConversations({ status: 'active' });
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
      meta.pinnedAt = null;
      meta.pinnedOrder = null;
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
    updateModelEffort,
    appendMessage,
    updateLastMessage,
    updateMessageById,
    replaceMessages,
    addUsage,
    archiveConversation,
    restoreConversation,
    pinConversation,
    unpinConversation,
    reorderPinnedConversations,
    autoArchiveConversations,
    deleteConversation,
  };
}
