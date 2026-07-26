import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, rmSync, watchFile, unwatchFile } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { contextAccountingModelKey } from '@peer-agent/protocol';

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
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  try {
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

function appendJsonl(filePath, row) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value), 'utf8');
  try {
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

function writeChangeEvent(storeDir, event) {
  const changeFile = path.join(storeDir, '.changes.json');
  writeFileSync(changeFile, JSON.stringify({
    ...event,
    revision: `${Date.now()}-${randomUUID()}`,
    writerPid: process.pid,
    changedAt: new Date().toISOString(),
  }), 'utf8');
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

function normalizeContextSnapshot(snapshot, meta) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (snapshot.version !== 1) return null;
  const conversationId = typeof snapshot.conversationId === 'string'
    ? snapshot.conversationId.trim()
    : '';
  const contentRevision = Number(snapshot.contentRevision);
  const modelKey = typeof snapshot.modelKey === 'string' ? snapshot.modelKey.trim() : '';
  const revision = Number(snapshot.revision);
  const compactionEpoch = Number(snapshot.compactionEpoch);
  if (!conversationId || !modelKey) return null;
  if (!Number.isSafeInteger(contentRevision) || contentRevision < 0) return null;
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  if (!Number.isSafeInteger(compactionEpoch) || compactionEpoch < 0) return null;
  const phases = new Set([
    'request_preflight',
    'stream_preview',
    'tool_result',
    'post_compaction',
    'turn_complete',
    'restored',
    'model_changed',
  ]);
  if (!phases.has(snapshot.phase)) return null;
  const normalizeNullablePositive = (value) => {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
  };
  const normalizeNullableNonNegative = (value) => {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
  };
  const contextWindow = normalizeNullablePositive(snapshot.contextWindow);
  const inputBudget = normalizeNullablePositive(snapshot.inputBudget);
  const compactionThresholdTokens = normalizeNullablePositive(snapshot.compactionThresholdTokens);
  const authoritativeInputTokens = normalizeNullableNonNegative(snapshot.authoritativeInputTokens);
  const percent = normalizeNullableNonNegative(snapshot.percent);
  if (
    contextWindow === undefined
    || inputBudget === undefined
    || compactionThresholdTokens === undefined
    || authoritativeInputTokens === undefined
    || percent === undefined
  ) return null;
  const pressureSources = new Set([
    'provider_usage',
    'provider_count_api',
    'provider_tokenizer',
    'provider_error_evidence',
    'unknown',
  ]);
  if (!pressureSources.has(snapshot.pressureSource)) return null;
  if (typeof snapshot.pendingUncountedChanges !== 'boolean') return null;
  const pendingContentChars = Number(snapshot.pendingContentChars);
  if (!Number.isSafeInteger(pendingContentChars) || pendingContentChars < 0) return null;
  const capability = snapshot.countCapability;
  if (!capability || typeof capability !== 'object') return null;
  if (![
    'provider_count_api',
    'provider_tokenizer',
    'observed_usage_only',
    'unavailable',
  ].includes(capability.kind)) return null;
  if (
    capability.kind === 'provider_tokenizer'
    && (typeof capability.tokenizerVersion !== 'string' || !capability.tokenizerVersion.trim())
  ) return null;
  if (snapshot.counterStatus !== 'active' && snapshot.counterStatus !== 'degraded') return null;
  const updatedAt = Number(snapshot.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return null;
  if (conversationId !== String(meta?.id ?? '')) return null;
  if (contentRevision !== Number(meta?.contentRevision ?? 0)) return null;
  const providerBinding = normalizeModelProviderId(meta?.modelProviderId);
  const storedModel = typeof meta?.model === 'string' && meta.model.trim()
    ? meta.model.trim()
    : null;
  const expectedModelKey = contextAccountingModelKey(providerBinding, storedModel);
  const legacyModelKey = providerBinding ?? storedModel;
  if (modelKey !== expectedModelKey && modelKey !== legacyModelKey) return null;
  return {
    ...snapshot,
    version: 1,
    conversationId,
    contentRevision,
    modelKey: expectedModelKey,
    revision,
    phase: snapshot.phase,
    compactionEpoch,
    contextWindow,
    inputBudget,
    compactionThresholdTokens,
    authoritativeInputTokens,
    percent,
    pressureSource: snapshot.pressureSource,
    pendingUncountedChanges: snapshot.pendingUncountedChanges,
    pendingContentChars,
    countCapability: capability.kind === 'provider_tokenizer'
      ? { kind: capability.kind, tokenizerVersion: capability.tokenizerVersion.trim() }
      : { kind: capability.kind },
    counterStatus: snapshot.counterStatus,
    updatedAt,
  };
}

function normalizeMeta(meta) {
  const status = normalizeStatus(meta?.status);
  const pinnedAt = typeof meta?.pinnedAt === 'string' && meta.pinnedAt.trim() ? meta.pinnedAt : null;
  const pinnedOrder = pinnedAt && Number.isFinite(Number(meta?.pinnedOrder)) ? Number(meta.pinnedOrder) : null;
  // messageCount 写入 index 后，列表路径可直接读 meta；缺省时保持 undefined，由 withMessageCount 惰性回填。
  const messageCount = Number.isFinite(Number(meta?.messageCount)) ? Number(meta.messageCount) : undefined;
  const model = typeof meta?.model === 'string' && meta.model.trim() ? meta.model.trim() : null;
  const contentRevisionRaw = Number(meta?.contentRevision);
  const contentRevision = Number.isSafeInteger(contentRevisionRaw) && contentRevisionRaw >= 0
    ? contentRevisionRaw
    : 0;
  const normalizedBase = {
    ...meta,
    contentRevision,
  };
  return {
    ...normalizedBase,
    mode: normalizeMode(meta?.mode),
    effort: normalizeEffort(meta?.effort),
    modelProviderId: normalizeModelProviderId(meta?.modelProviderId),
    model,
    contextSnapshot: normalizeContextSnapshot(meta?.contextSnapshot, normalizedBase),
    status,
    archivedAt: status === 'archived' ? (meta?.archivedAt || meta?.updatedAt || meta?.createdAt || null) : null,
    pinnedAt,
    pinnedOrder,
    ...(messageCount === undefined ? {} : { messageCount }),
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


function normalizeSearchQuery(query) {
  return String(query || '').trim().toLowerCase();
}

function workspaceShortName(workspacePath) {
  if (!workspacePath) return '';
  const normalized = String(workspacePath).replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : normalized;
}

/**
 * Title-first conversation search ranker (P0 Search Chats).
 * Higher score wins; empty query returns 0 for every candidate so callers can
 * fall back to recency ordering without inventing match quality.
 */
export function rankConversationMatch(meta, query, { includeWorkspaceNameMatch = false } = {}) {
  const q = normalizeSearchQuery(query);
  if (!q) return 0;
  const title = normalizeSearchQuery(meta?.title);
  if (title.includes(q)) {
    if (title === q) return 300;
    if (title.startsWith(q)) return 200;
    return 100;
  }
  if (includeWorkspaceNameMatch) {
    const wsName = normalizeSearchQuery(workspaceShortName(meta?.workspacePath));
    if (wsName && wsName.includes(q)) return 50;
  }
  return -1;
}

function sortByUpdatedAtDesc(items) {
  return [...items].sort((a, b) => {
    const ak = String(a?.updatedAt || a?.createdAt || '');
    const bk = String(b?.updatedAt || b?.createdAt || '');
    return bk.localeCompare(ak);
  });
}

export function createConversationStore({
  storeDir = defaultStoreDir(),
  usageLogFile = path.join(path.dirname(storeDir), 'usage', 'requests.jsonl'),
} = {}) {
  const indexFile = path.join(storeDir, 'index.jsonl');
  const contextSnapshotDir = path.join(storeDir, '.context-snapshots');

  // 撤销 'goal'→'plan' 兼容映射前,先对存量数据做一次性迁移,避免历史 'goal' 被误判为自驱语义。
  migrateLegacyGoalMode(storeDir, indexFile);

  function convFile(id) { return path.join(storeDir, `${id}.jsonl`); }
  function contextSnapshotFile(id) {
    return path.join(contextSnapshotDir, `${encodeURIComponent(id)}.json`);
  }
  function durableContextSnapshot(meta) {
    return normalizeContextSnapshot(readJson(contextSnapshotFile(meta.id)), meta)
      ?? meta.contextSnapshot
      ?? null;
  }
  function publishChange(meta, changeType) {
    if (!meta?.id) return;
    writeChangeEvent(storeDir, {
      conversationId: meta.id,
      workspacePath: meta.workspacePath ?? null,
      changeType,
    });
  }

  function readIndex() { return readJsonl(indexFile).map(normalizeMeta); }

  function withMessageCount(meta) {
    if (!meta) return null;
    if (Number.isFinite(Number(meta.messageCount))) {
      return { ...meta, messageCount: Number(meta.messageCount) };
    }
    // list 热路径禁止同步读会话正文；缺 count 时返回占位，由后台迁移回填。
    return { ...meta, messageCount: 0 };
  }

  function computeMessageCount(id) {
    return existsSync(convFile(id)) ? readJsonl(convFile(id)).length : 0;
  }

  /**
   * 为缺 messageCount 的 index 行批量回填并一次写回。
   * 仅用于后台迁移 / 显式 backfill，不在 list 热路径调用。
   */
  function ensureMessageCounts(metas) {
    let dirty = false;
    const byId = new Map();
    const next = metas.map((meta) => {
      if (Number.isFinite(Number(meta.messageCount))) {
        const normalized = { ...meta, messageCount: Number(meta.messageCount) };
        byId.set(meta.id, normalized);
        return normalized;
      }
      dirty = true;
      const filled = { ...meta, messageCount: computeMessageCount(meta.id) };
      byId.set(meta.id, filled);
      return filled;
    });
    if (dirty) {
      const index = readIndex().map((row) => {
        if (!Number.isFinite(Number(row.messageCount)) && byId.has(row.id)) {
          return byId.get(row.id);
        }
        return row;
      });
      writeJsonl(indexFile, index);
    }
    return next;
  }

  let messageCountMigrationScheduled = false;
  let messageCountMigrationTimer = null;

  function scheduleMessageCountMigration(ids = null) {
    const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids.filter(Boolean)) : null;
    if (messageCountMigrationScheduled && !wanted) return;
    messageCountMigrationScheduled = true;
    if (messageCountMigrationTimer) return;
    messageCountMigrationTimer = setTimeout(() => {
      messageCountMigrationTimer = null;
      messageCountMigrationScheduled = false;
      try {
        const index = readIndex();
        let dirty = false;
        const next = index.map((row) => {
          if (Number.isFinite(Number(row.messageCount))) {
            return { ...row, messageCount: Number(row.messageCount) };
          }
          if (wanted && !wanted.has(row.id)) return row;
          dirty = true;
          return { ...row, messageCount: computeMessageCount(row.id) };
        });
        if (dirty) writeJsonl(indexFile, next);
      } catch (err) {
        // 后台迁移失败不影响 list；下次 list 会再次调度。
        console.warn('[conversation-store] messageCount migration failed:', err);
      }
    }, 0);
  }

  function normalizeListLimit(value, { defaultLimit = null, maxLimit = 500 } = {}) {
    if (value === undefined || value === null || value === '') return defaultLimit;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return defaultLimit;
    return Math.min(Math.floor(n), maxLimit);
  }

  function applyListPagination(items, params = {}) {
    const limit = normalizeListLimit(params?.limit, { defaultLimit: null });
    const cursor = typeof params?.cursor === 'string' && params.cursor.trim()
      ? params.cursor.trim()
      : null;
    let start = 0;
    if (cursor) {
      const idx = items.findIndex((item) => item.id === cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    if (limit == null) {
      return {
        items: items.slice(start),
        nextCursor: null,
        hasMore: false,
        total: items.length,
      };
    }
    const page = items.slice(start, start + limit);
    const end = start + page.length;
    const hasMore = end < items.length;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
      hasMore,
      total: items.length,
    };
  }

  function projectListMeta(meta) {
    if (!meta) return null;
    if (Number.isFinite(Number(meta.messageCount))) {
      return { ...meta, messageCount: Number(meta.messageCount) };
    }
    // 热路径永不读 jsonl：缺 count 返回 0 占位，并调度后台回填。
    return { ...meta, messageCount: 0 };
  }

  function listConversations(params = {}) {
    const statuses = normalizeStatuses(params?.status);
    const filtered = readIndex()
      .filter((meta) => !statuses || statuses.has(normalizeStatus(meta.status)));
    const sorted = sortByUpdatedAtDesc(filtered.map((meta) => ({ ...meta })));

    // 显式 backfill 仅用于迁移工具/测试；默认 list 热路径永不读正文。
    if (params?.backfillMessageCount === true) {
      const filled = ensureMessageCounts(sorted);
      const page = applyListPagination(filled, params);
      return params?.paginated === true ? page : page.items;
    }

    const missingIds = sorted
      .filter((meta) => !Number.isFinite(Number(meta.messageCount)))
      .map((meta) => meta.id);
    if (missingIds.length > 0 && params?.includeMessageCount !== false) {
      scheduleMessageCountMigration(missingIds);
    }

    const projected = params?.includeMessageCount === false
      ? sorted
      : sorted.map(projectListMeta);
    const page = applyListPagination(projected, params);
    return params?.paginated === true ? page : page.items;
  }

  function listConversationsByWorkspace(workspacePath, params = {}) {
    const statuses = normalizeStatuses(params?.status);
    // 先按 index meta 过滤 workspace / status，再投影 messageCount。
    // 避免「先全量扫 jsonl 再过滤」的历史路径。
    const filtered = readIndex().filter((meta) => {
      if ((meta.workspacePath || null) !== (workspacePath || null)) return false;
      if (statuses && !statuses.has(normalizeStatus(meta.status))) return false;
      return true;
    });
    const sorted = sortByUpdatedAtDesc(filtered.map((meta) => ({ ...meta })));

    if (params?.backfillMessageCount === true) {
      const filled = ensureMessageCounts(sorted);
      const page = applyListPagination(filled, params);
      return params?.paginated === true ? page : page.items;
    }

    const missingIds = sorted
      .filter((meta) => !Number.isFinite(Number(meta.messageCount)))
      .map((meta) => meta.id);
    if (missingIds.length > 0 && params?.includeMessageCount !== false) {
      scheduleMessageCountMigration(missingIds);
    }

    const projected = params?.includeMessageCount === false
      ? sorted
      : sorted.map(projectListMeta);
    const page = applyListPagination(projected, params);
    return params?.paginated === true ? page : page.items;
  }



  /**
   * Cross-workspace conversation search over index meta only (no per-chat jsonl).
   * P0: active-only by default, title match, recency fallback when query is empty.
   */
  function searchConversations(params = {}) {
    const query = normalizeSearchQuery(params?.query);
    const limitRaw = Number(params?.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50;
    const includeWorkspaceNameMatch = Boolean(params?.includeWorkspaceNameMatch);
    // Default active-only for Search Chats MVP (archived excluded unless requested).
    const statuses = normalizeStatuses(params?.status ?? 'active');
    const workspaceFilter = params?.workspacePath !== undefined
      ? (params.workspacePath || null)
      : undefined;

    const recencyKey = (meta) => String(meta?.updatedAt || meta?.createdAt || '');

    let items = readIndex().filter((meta) => {
      if (statuses && !statuses.has(normalizeStatus(meta.status))) return false;
      if (workspaceFilter !== undefined && (meta.workspacePath || null) !== workspaceFilter) return false;
      return true;
    });

    if (query) {
      items = items
        .map((meta) => ({ meta, score: rankConversationMatch(meta, query, { includeWorkspaceNameMatch }) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return recencyKey(b.meta).localeCompare(recencyKey(a.meta));
        })
        .map((entry) => entry.meta);
    } else {
      items = items.sort((a, b) => recencyKey(b).localeCompare(recencyKey(a)));
    }

    return items.slice(0, limit);
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
      messageCount: 0,
      contentRevision: 0,
      contextSnapshot: null,
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
    return withMessageCount(meta);
  }

  // 会话级模型 + 思考模式绑定（随会话持久化，同 mode 范式）。两者各自独立写入，互不影响：
  // 用户可只切模型不切思考档，或反之。modelProviderId 为 null 表示回退到全局默认 provider。
  // 强绑定校验不在存储层做——发送时 orderProviderCandidates 会校验首选 provider 是否仍可用，
  // 不可用则自动回退；这里只负责如实存取用户的选择。
  function updateModelEffort(id, { effort, modelProviderId, model } = {}) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    const previousProviderId = normalizeModelProviderId(meta.modelProviderId);
    const previousModel = typeof meta.model === 'string' && meta.model.trim() ? meta.model.trim() : null;
    const previousContextModelKey = contextAccountingModelKey(previousProviderId, previousModel);
    if (effort !== undefined) meta.effort = normalizeEffort(effort);
    if (modelProviderId !== undefined) meta.modelProviderId = normalizeModelProviderId(modelProviderId);
    // 发送成功后可把本轮实际 model 快照落盘；null/空串表示清除。
    if (model !== undefined) {
      meta.model = typeof model === 'string' && model.trim() ? model.trim() : null;
    }
    const nextProviderId = normalizeModelProviderId(meta.modelProviderId);
    const nextModel = typeof meta.model === 'string' && meta.model.trim() ? meta.model.trim() : null;
    if (previousContextModelKey !== contextAccountingModelKey(nextProviderId, nextModel)) {
      meta.contextSnapshot = null;
    }
    meta.updatedAt = new Date().toISOString();
    writeJsonl(indexFile, index);
    return withMessageCount(meta);
  }

  function updateContextSnapshot(id, snapshot = {}) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    const contentRevisionRaw = Number(meta.contentRevision);
    const contentRevision = Number.isSafeInteger(contentRevisionRaw) && contentRevisionRaw >= 0
      ? contentRevisionRaw
      : 0;
    const candidate = {
      ...snapshot,
      conversationId: id,
      contentRevision,
      modelKey: contextAccountingModelKey(
        normalizeModelProviderId(meta.modelProviderId),
        typeof meta.model === 'string' ? meta.model : null,
      ),
    };
    const normalized = normalizeContextSnapshot(candidate, { ...meta, contentRevision });
    if (!normalized) return null;
    meta.contentRevision = contentRevision;
    meta.contextSnapshot = normalized;
    writeJsonl(indexFile, index);
    // Keep the capacity snapshot in a sidecar as the cross-process authority.
    // Older Desktop/TUI builds rewrite the whole index after normalizing fields
    // they understand and can erase a newer snapshot. The sidecar survives that
    // metadata write and is still rejected normally when model/content revision
    // no longer matches.
    writeJson(contextSnapshotFile(id), normalized);
    return withMessageCount(meta);
  }

  function getConversation(id) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    const messages = readJsonl(convFile(id));
    return {
      ...meta,
      contextSnapshot: durableContextSnapshot(meta),
      messages,
    };
  }

  function getLatestObservedUsage(id, { model } = {}) {
    const conversationId = typeof id === 'string' ? id.trim() : '';
    const expectedModel = typeof model === 'string' ? model.trim() : '';
    if (!conversationId || !existsSync(usageLogFile)) return null;
    const rows = readJsonl(usageLogFile);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row?.conversationId !== conversationId) continue;
      if (expectedModel && typeof row.model === 'string' && row.model.trim() !== expectedModel) {
        continue;
      }
      const inputTokens = Number(row?.inputTokens);
      const cacheReadTokens = Number(row?.cacheReadTokens);
      const input = Number.isFinite(inputTokens) && inputTokens >= 0 ? Math.floor(inputTokens) : 0;
      const cacheRead = Number.isFinite(cacheReadTokens) && cacheReadTokens >= 0
        ? Math.floor(cacheReadTokens)
        : 0;
      if (input <= 0 && cacheRead <= 0) continue;
      return { inputTokens: input, cacheReadTokens: cacheRead };
    }
    return null;
  }

  function updateTitle(id, title) {
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (!meta) return null;
    meta.title = title;
    meta.updatedAt = new Date().toISOString();
    writeJsonl(indexFile, index);
    return withMessageCount(meta);
  }


  function isEmptyUserMessage(message) {
    if (!message || message.role !== 'user') return false;
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (content.length > 0) return false;
    return !Array.isArray(message.attachments) || message.attachments.length === 0;
  }

  function withoutEmptyUserMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.filter((message) => !isEmptyUserMessage(message));
  }

  function appendMessage(id, message) {
    return withFileLock(indexFile, () => {
      const index = readIndex();
      const meta = index.find((c) => c.id === id);
      if (!meta) return null;
      // Refuse empty user bubbles (no text, no attachments). They only surface as a bare
      // "你" label in the UI and have no durable conversation value.
      if (isEmptyUserMessage(message)) {
        return withMessageCount(meta);
      }
      withFileLock(convFile(id), () => appendJsonl(convFile(id), message));
      if (!meta.title && message.role === 'user') {
        meta.title = message.content.slice(0, 50);
      }
      // index 维护 messageCount，listConversations 不再扫全文 jsonl。
      const prevCount = Number.isFinite(Number(meta.messageCount)) ? Number(meta.messageCount) : null;
      meta.messageCount = prevCount === null
        ? readJsonl(convFile(id)).length
        : prevCount + 1;
      meta.contentRevision = (Number.isSafeInteger(Number(meta.contentRevision)) ? Number(meta.contentRevision) : 0) + 1;
      meta.contextSnapshot = null;
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
    if (meta) {
      meta.contentRevision = (Number.isSafeInteger(Number(meta.contentRevision)) ? Number(meta.contentRevision) : 0) + 1;
      meta.contextSnapshot = null;
      meta.updatedAt = new Date().toISOString();
      writeJsonl(indexFile, index);
    }
    return meta ? { ...meta, messages } : null;
  }

  function replaceMessages(id, newMessages, options = {}) {
    const existingMessages = readJsonl(convFile(id));
    const durableMessages = withoutEmptyUserMessages(newMessages);
    if (durableMessages.length === 0 && existingMessages.length > 0 && options.allowEmpty !== true) {
      throw new Error(`Refusing to replace non-empty conversation ${id} with an empty message list`);
    }
    writeJsonl(convFile(id), durableMessages);
    const index = readIndex();
    const meta = index.find((c) => c.id === id);
    if (meta) {
      meta.messageCount = Array.isArray(durableMessages) ? durableMessages.length : 0;
      meta.contentRevision = (Number.isSafeInteger(Number(meta.contentRevision)) ? Number(meta.contentRevision) : 0) + 1;
      meta.contextSnapshot = null;
      meta.updatedAt = new Date().toISOString();
      writeJsonl(indexFile, index);
    }
    return meta ? { ...meta, messages: durableMessages } : null;
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
    if (meta) {
      meta.contentRevision = (Number.isSafeInteger(Number(meta.contentRevision)) ? Number(meta.contentRevision) : 0) + 1;
      meta.contextSnapshot = null;
      meta.updatedAt = new Date().toISOString();
      writeJsonl(indexFile, index);
    }
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
    return withMessageCount(meta);
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
    try {
      const snapshotFile = contextSnapshotFile(id);
      if (existsSync(snapshotFile)) unlinkSync(snapshotFile);
    } catch {}
    return index.map((meta) => {
      return withMessageCount(meta);
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

  function changed(operation, changeType) {
    return (...args) => {
      const result = operation(...args);
      const id = result?.id || (typeof args[0] === 'string' ? args[0] : null);
      const meta = result?.id ? result : (id ? readIndex().find((entry) => entry.id === id) : null);
      if (meta) publishChange(meta, changeType);
      return result;
    };
  }

  function subscribeChanges(listener, { interval = 200 } = {}) {
    const changeFile = path.join(storeDir, '.changes.json');
    mkdirSync(storeDir, { recursive: true });
    let lastRevision = null;
    const handleChange = () => {
      try {
        const event = JSON.parse(readFileSync(changeFile, 'utf8'));
        if (!event?.revision || event.revision === lastRevision) return;
        lastRevision = event.revision;
        listener(event);
      } catch {
        // The journal may not exist yet or may be between atomic observations.
      }
    };
    watchFile(changeFile, { interval, persistent: false }, handleChange);
    return () => unwatchFile(changeFile, handleChange);
  }

  return {
    listConversations,
    listConversationsByWorkspace,
    scheduleMessageCountMigration,
    backfillMessageCounts: () => ensureMessageCounts(readIndex()),
    searchConversations,
    createConversation: changed(createConversation, 'created'),
    getConversation,
    getLatestObservedUsage,
    updateTitle: changed(updateTitle, 'metadata-updated'),
    updateMode: changed(updateMode, 'metadata-updated'),
    updateModelEffort: changed(updateModelEffort, 'metadata-updated'),
    updateContextSnapshot: changed(updateContextSnapshot, 'metadata-updated'),
    appendMessage: changed(appendMessage, 'messages-updated'),
    updateLastMessage: changed(updateLastMessage, 'messages-updated'),
    updateMessageById: changed(updateMessageById, 'messages-updated'),
    replaceMessages: changed(replaceMessages, 'messages-updated'),
    addUsage: changed(addUsage, 'metadata-updated'),
    archiveConversation: changed(archiveConversation, 'metadata-updated'),
    restoreConversation: changed(restoreConversation, 'metadata-updated'),
    pinConversation: changed(pinConversation, 'metadata-updated'),
    unpinConversation: changed(unpinConversation, 'metadata-updated'),
    reorderPinnedConversations,
    autoArchiveConversations,
    deleteConversation: changed(deleteConversation, 'deleted'),
    subscribeChanges,
  };
}
