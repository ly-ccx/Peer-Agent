/**
 * 待批准项的持久记录。
 *
 * 执行仍由内存中的 permission-gate 负责。这里只追加事实：
 * 每个 workspaceId 一个 jsonl，没有 workspaceId 的会话写到 _unscoped。
 * 读取时按 approvalId 折叠为最新状态。文件超过阈值时，压成只含 open / stale 的快照。
 *
 * PendingApproval 的协议类型由 B1-07 定义。在那之前，形状以本文件的 JSDoc 为准。
 *
 * @typedef {'open' | 'approved' | 'denied' | 'expired' | 'stale'} ApprovalState
 * @typedef {'local_ui' | 'policy'} ApprovalDecider
 * @typedef {Object} PendingApproval
 * @property {string} approvalId 权限请求的 toolCallId
 * @property {string | null} workspaceId
 * @property {string | null} conversationId
 * @property {string | null} streamId
 * @property {string | null} planId
 * @property {string} capabilityId
 * @property {string} summary 展示文本，已脱敏
 * @property {string | null} riskLevel
 * @property {string} argsDigest 参数的 sha256
 * @property {string} createdAt
 * @property {ApprovalState} state
 * @property {string} [decidedAt]
 * @property {ApprovalDecider} [decidedBy]
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathOf } from '../data-store.mjs';

const STATES = new Set(['open', 'approved', 'denied', 'expired', 'stale']);
const DECIDERS = new Set(['local_ui', 'policy']);
const KEPT_ON_COMPACT = new Set(['open', 'stale']);
const WORKSPACE_DIR = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UNSCOPED_DIR = '_unscoped';
const DEFAULT_COMPACT_BYTES = 5 * 1024 * 1024;
const SUMMARY_LIMIT = 240;

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** 参数摘要。同一参数对象得到同一个 sha256，不把参数正文写进记录。 */
export function digestApprovalArgs(args) {
  let encoded = '"unserializable"';
  try {
    encoded = stableStringify(args ?? null);
  } catch {
    encoded = '"unserializable"';
  }
  return createHash('sha256').update(encoded).digest('hex');
}

function redactSummary(value) {
  const text = typeof value === 'string' ? value : '';
  return text
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9]{8,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(\S+)/gi, '$1[redacted]')
    .slice(0, SUMMARY_LIMIT);
}

function nullableString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function workspaceDir(workspaceId) {
  return typeof workspaceId === 'string' && WORKSPACE_DIR.test(workspaceId)
    ? workspaceId
    : UNSCOPED_DIR;
}

/**
 * @param {{ rootDir?: string | null, now?: () => Date, compactBytes?: number }} [options]
 */
export function createApprovalStore({
  rootDir = null,
  now = () => new Date(),
  compactBytes = DEFAULT_COMPACT_BYTES,
} = {}) {
  const limit = Number.isFinite(compactBytes) && compactBytes > 0
    ? compactBytes
    : DEFAULT_COMPACT_BYTES;

  function root() {
    return rootDir || pathOf('projectRuntime');
  }

  function fileFor(workspaceId) {
    return path.join(root(), workspaceDir(workspaceId), 'approvals.jsonl');
  }

  function normalize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const approvalId = nullableString(input.approvalId);
    if (!approvalId || approvalId.length > 200) return null;
    if (!STATES.has(input.state)) return null;
    const record = {
      approvalId,
      workspaceId: workspaceDir(input.workspaceId) === UNSCOPED_DIR ? null : input.workspaceId,
      conversationId: nullableString(input.conversationId),
      streamId: nullableString(input.streamId),
      planId: nullableString(input.planId),
      ...(nullableString(input.sessionId) ? { sessionId: nullableString(input.sessionId) } : {}),
      capabilityId: nullableString(input.capabilityId) || 'unknown',
      summary: redactSummary(input.summary),
      riskLevel: nullableString(input.riskLevel),
      argsDigest: typeof input.argsDigest === 'string' && /^[a-f0-9]{64}$/i.test(input.argsDigest)
        ? input.argsDigest.toLowerCase()
        : digestApprovalArgs(null),
      createdAt: nullableString(input.createdAt) || now().toISOString(),
      state: input.state,
    };
    const decidedAt = nullableString(input.decidedAt);
    if (decidedAt) record.decidedAt = decidedAt;
    if (DECIDERS.has(input.decidedBy)) record.decidedBy = input.decidedBy;
    return record;
  }

  function readLines(file) {
    if (!existsSync(file)) return [];
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const records = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = normalize(JSON.parse(line));
        if (record) records.push(record);
      } catch {
        // 坏行跳过，不让一行损坏挡住其余事实。
      }
    }
    return records;
  }

  function foldRecords(records) {
    const byId = new Map();
    for (const record of records) byId.set(record.approvalId, record);
    return [...byId.values()];
  }

  function approvalFiles() {
    const dir = root();
    if (!existsSync(dir)) return [];
    const files = [];
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'approvals.jsonl');
      if (existsSync(file)) files.push(file);
    }
    return files;
  }

  function foldAll() {
    const records = [];
    for (const file of approvalFiles()) records.push(...readLines(file));
    return foldRecords(records);
  }

  function replaceFile(file, text) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, 'utf8');
    renameSync(temporary, file);
  }

  function maybeCompact(file) {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size <= limit) return;
    const kept = foldRecords(readLines(file)).filter((record) => KEPT_ON_COMPACT.has(record.state));
    const text = kept.length ? `${kept.map((record) => JSON.stringify(record)).join('\n')}\n` : '';
    replaceFile(file, text);
  }

  function latestInFile(file, approvalId) {
    const records = readLines(file);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].approvalId === approvalId) return records[index];
    }
    return null;
  }

  /**
   * 追加一条状态变化。同一 approvalId 再次写入相同 state 时不落盘。
   * @param {Partial<PendingApproval>} input
   * @returns {PendingApproval | null}
   */
  function append(input) {
    const record = normalize(input);
    if (!record) return null;
    const file = fileFor(record.workspaceId);
    const current = latestInFile(file, record.approvalId);
    if (current && current.state === record.state) return current;
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    maybeCompact(file);
    return record;
  }

  function list(filter = {}) {
    return foldAll().filter((record) => {
      if (filter.state && record.state !== filter.state) return false;
      if (filter.streamId && record.streamId !== filter.streamId) return false;
      if (filter.conversationId && record.conversationId !== filter.conversationId) return false;
      if (Object.prototype.hasOwnProperty.call(filter, 'workspaceId')
        && filter.workspaceId !== undefined
        && record.workspaceId !== filter.workspaceId) return false;
      return true;
    });
  }

  /** 进程启动：所有 open 变成 stale。没有 open 时不写盘。 */
  function markStaleOnStartup() {
    const decidedAt = now().toISOString();
    const changed = [];
    for (const record of list({ state: 'open' })) {
      const next = append({
        ...record,
        state: 'stale',
        decidedAt,
      });
      if (next) changed.push(next);
    }
    return changed;
  }

  return {
    append,
    list,
    markStaleOnStartup,
    fileFor,
  };
}

function runningLeafIds(tasks, out = []) {
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || typeof task !== 'object') continue;
    const children = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (children.length > 0) {
      runningLeafIds(children, out);
      continue;
    }
    if (task.status === 'running' && typeof task.taskId === 'string' && task.taskId) {
      out.push(task.taskId);
    }
  }
  return out;
}

/**
 * 启动装配：open 转 stale；仍在执行的 GoalPlan 按 ADR 73 挂起。
 * 没有 GoalPlan 的会话只标记，不恢复。一次性批准 stale 项留给 B3-01。
 * @param {{ approvalStore?: { markStaleOnStartup?: () => PendingApproval[] }, goalPlanStore?: object, now?: () => Date }} [deps]
 */
export function applyStartupApprovalRecovery({
  approvalStore = null,
  goalPlanStore = null,
  now = () => new Date(),
} = {}) {
  if (!approvalStore || typeof approvalStore.markStaleOnStartup !== 'function') {
    return { stale: [], interruptedPlanIds: [] };
  }
  let stale = [];
  try {
    stale = approvalStore.markStaleOnStartup() || [];
  } catch {
    return { stale: [], interruptedPlanIds: [] };
  }
  const interruptedPlanIds = [];
  const seen = new Set();
  for (const row of stale) {
    const planId = row?.planId;
    if (!planId || seen.has(planId)) continue;
    seen.add(planId);
    try {
      const plan = goalPlanStore?.getPlan?.(planId);
      if (!plan || plan.status !== 'executing') continue;
      if (typeof goalPlanStore.recordTaskEvidence === 'function') {
        for (const taskId of runningLeafIds(plan.tasks)) {
          try {
            goalPlanStore.recordTaskEvidence(planId, taskId, { status: 'pending' });
          } catch {
            // 单片叶子写不进去时，计划级挂起仍然继续。
          }
        }
      }
      const interruptedAt = now().toISOString();
      goalPlanStore.setRunnerState?.(planId, {
        enabled: true,
        status: 'paused',
        intent: 'block',
        phase: 'blocked',
        interruption: {
          source: 'approval_interrupted',
          reason: 'approval_interrupted',
          interruptedAt,
        },
      });
      const updated = goalPlanStore.getPlan?.(planId);
      if (updated && updated.status !== 'interrupted') {
        goalPlanStore.setPlanStatus?.(planId, 'interrupted');
      }
      interruptedPlanIds.push(planId);
    } catch {
      // 一条计划写失败不挡住其余批准记录转 stale。
    }
  }
  return { stale, interruptedPlanIds };
}
