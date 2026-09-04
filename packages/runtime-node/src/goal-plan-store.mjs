import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  watch,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathOf } from './data-store.mjs';
import { attachWorkspaceHeadBinding } from './goal-delivery-binding.mjs';
import { normalizeGoalCheckpoint, validateGoalCheckpoint } from '@peer-agent/runtime-core';
import {
  assertAcceptanceCloseGate,
  collectHeldEvidenceRefs,
  isAcceptanceClosePatch,
} from '@peer-agent/protocol';

/**
 * Goal 计划持久化 store —— 见 Goal 模式设计。
 *
 * 设计要点（与提案 §3/§4/§6 一致）：
 * - 计划是持久化的 Evidence/artifact，目录型多记录：index.jsonl（轻量元信息，
 *   用于列表）+ 每个计划一个 `${planId}.json`（全量 GoalPlan）。
 * - 原子写：先写 `.tmp` 再 rename，避免半截文件损坏。
 * - 子任务（含嵌套）状态只能由 Evidence 回写；置为 'completed' 必须带 evidenceRefs。
 * - progress 由子任务自底向上聚合，调用方不可手填（每次写入都会重算覆盖）。
 *
 * 协议类型见 packages/protocol/src/goal.ts。关闭闸门（resultAcceptance）
 * 与协议层 evaluateAcceptanceCloseGate 共用。不 import electron，可被单测直接 import。
 */

// maxExplorers 的硬上限护栏。历史语义为「每计划累计可派发 Explorer 总数」，现已弃用
// （不再作为累计闸），仅为兼容旧持久化数据保留字段。此上限继续对异常值做对称钳制。
const MAX_EXPLORERS_HARD_CAP = 10;

// explorerConcurrency 的硬上限护栏。每个 explorer 是一个完整的只读子 Agent loop，
// 直接是 token / 时间成本的乘数。并发上限可经外部（IPC options / runner 状态）传入，
// 此处补一个对称的上限挡住异常值（例如某轮请求几十个时把限流打爆）；默认 5 远低于上限。
const EXPLORER_CONCURRENCY_HARD_CAP = 8;
const DEFAULT_EXPLORER_CONCURRENCY = 5;

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * JSONL 文件级读缓存（性能治理 §12，multi-task-ui-performance-remediation.md）。
 *
 * 背景：多任务高并发时 listPlans() 以 ~300ms 周期被调用，每次全量
 * readFileSync + JSON.parse×N + normalizePlan×N（trace 实测 activeMeta 热点 4.7s/7.2s）。
 * 索引文件仅在写入时变化，且写入路径统一走 writeJsonl/appendJsonl（同进程）或
 * 外部进程写入（subscribeChanges 的 watcher 会感知）。
 *
 * 契约：statSync 命中（mtimeMs+size 一致）时复用解析结果，绝不复用可变对象引用——
 * 调用方（normalizePlan/filter/sort）可能产生新数组，但缓存返回的是同一份原始记录数组，
 * 因此读缓存返回浅拷贝数组，避免调用方 sort() 原地修改缓存。
 */
const jsonlReadCache = new Map(); // filePath -> { mtimeMs, size, records }

function readJsonlCached(filePath) {
  let stat = null;
  try {
    stat = statSync(filePath);
  } catch {
    jsonlReadCache.delete(filePath);
    return [];
  }
  const cached = jsonlReadCache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.records.slice(); // 浅拷贝：调用方可安全 sort/splice
  }
  const records = readJsonl(filePath);
  jsonlReadCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    records,
  });
  return records.slice();
}

const EVIDENCE_TAIL_SCAN_BYTES = 16 * 1024 * 1024;

/**
 * EvidenceIndex 可达数百 MB；任务概览只需要少量已知 ref，禁止为此全量解析。
 * 一次读取有界尾部再统一 UTF-8 解码，避免分块边界截断中文 JSON。
 */
function readEvidenceRecordsFromTail(filePath, refs, maxScanBytes = EVIDENCE_TAIL_SCAN_BYTES) {
  const wanted = new Set(normalizeEvidenceRefList(refs));
  if (wanted.size === 0 || !existsSync(filePath)) return [];
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxScanBytes);
    const start = size - length;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
    if (start > 0) lines.shift(); // 首行可能从 JSON 中间开始。
    const found = new Map();
    const resolvedOriginals = new Set();
    for (let index = lines.length - 1; index >= 0 && resolvedOriginals.size < wanted.size; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      let parsed;
      try {
        parsed = normalizeEvidenceIndexRecord(JSON.parse(line));
      } catch {
        continue;
      }
      if (!parsed || !wanted.has(parsed.evidenceRef)) continue;
      found.set(parsed.evidenceRef, mergeEvidenceIndexRecords(found.get(parsed.evidenceRef), parsed));
      if (!EVIDENCE_WRAPPER_TOOL_NAMES.has(parsed.toolName)) {
        resolvedOriginals.add(parsed.evidenceRef);
      }
    }
    return [...found.values()];
  } finally {
    closeSync(fd);
  }
}

function appendJsonl(filePath, obj) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function writeGoalChangeEvent(storeDir, event) {
  appendJsonl(path.join(storeDir, '.changes.jsonl'), {
    ...event,
    revision: `${Date.now()}-${randomUUID()}`,
    writerPid: process.pid,
    changedAt: new Date().toISOString(),
  });
}

function writeJsonl(filePath, items) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, items.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  renameSync(tmp, filePath);
  jsonlReadCache.delete(filePath);
}

function writeJsonAtomic(filePath, obj) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  renameSync(tmp, filePath);
  jsonReadCache.delete(filePath);
}

/** 单文件 JSON 读缓存（plan 详情热路径，避免 overview 反复 readFile+JSON.parse）。 */
const jsonReadCache = new Map(); // filePath -> { mtimeMs, size, value }

function readJson(filePath) {
  if (!existsSync(filePath)) {
    jsonReadCache.delete(filePath);
    return null;
  }
  let stat = null;
  try {
    stat = statSync(filePath);
  } catch {
    jsonReadCache.delete(filePath);
    return null;
  }
  const cached = jsonReadCache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.value;
  }
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    jsonReadCache.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      value,
    });
    return value;
  } catch {
    jsonReadCache.delete(filePath);
    return null;
  }
}

/** ExecutionStatus（execution.ts）——本 store 仅依赖这些字面量做聚合判定。 */
const TERMINAL_OK = 'completed';
const TERMINAL_FAIL = 'failed';
const TERMINAL_CANCEL = 'cancelled';
const BLOCKED = 'waiting_user';
const LEAF_TERMINAL_STATUSES = new Set([TERMINAL_OK, TERMINAL_FAIL, TERMINAL_CANCEL]);

/** Plan 终态：关闭 active segment 并落盘 duration。 */
const PLAN_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
/** 停表状态：人在回路 / 暂停。 */
const PLAN_PAUSE_STATUSES = new Set(['paused']);
/** 开表状态：真正在跑。 */
const PLAN_ACTIVE_STATUSES = new Set(['executing']);
/**
 * Runner 人在回路 / 暂停态：即使 plan 仍为 executing 也停表。
 * exploring / compacting_context 等系统侧工作不停表。
 */
const RUNNER_PAUSE_STATUSES = new Set(['paused', 'waiting_user', 'blocked', 'budget_exhausted']);
const RUNNER_ACTIVE_STATUSES = new Set([
  'running',
  'compacting_context',
  'resuming_after_compaction',
  'exploring',
]);

function toIsoOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
}

function nonNegInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

/**
 * 规范化 GoalTiming 账本。历史 plan 无 timing 时返回 undefined。
 * @param {object|null|undefined} timing
 * @returns {object|undefined}
 */
export function normalizeGoalTiming(timing) {
  if (!timing || typeof timing !== 'object') return undefined;
  const startedAt = toIsoOrNull(timing.startedAt) || undefined;
  const completedAt = toIsoOrNull(timing.completedAt) || undefined;
  const activeSegmentStartedAt = toIsoOrNull(timing.activeSegmentStartedAt) || undefined;
  const activeAccumulatedMs = nonNegInt(timing.activeAccumulatedMs, 0);
  const next = {
    activeAccumulatedMs,
  };
  if (startedAt) next.startedAt = startedAt;
  if (completedAt) next.completedAt = completedAt;
  if (activeSegmentStartedAt) next.activeSegmentStartedAt = activeSegmentStartedAt;
  if (typeof timing.wallClockMs === 'number' && Number.isFinite(timing.wallClockMs)) {
    next.wallClockMs = nonNegInt(timing.wallClockMs, 0);
  }
  if (typeof timing.activeMs === 'number' && Number.isFinite(timing.activeMs)) {
    next.activeMs = nonNegInt(timing.activeMs, 0);
  }
  // 没有任何时间标记且累计为 0 → 视为缺省
  if (!startedAt && !completedAt && !activeSegmentStartedAt
    && activeAccumulatedMs === 0
    && next.wallClockMs === undefined
    && next.activeMs === undefined) {
    return undefined;
  }
  return next;
}

function closeActiveSegment(timing, nowIso) {
  const base = {
    activeAccumulatedMs: nonNegInt(timing?.activeAccumulatedMs, 0),
  };
  if (timing?.startedAt) base.startedAt = timing.startedAt;
  if (timing?.completedAt) base.completedAt = timing.completedAt;
  if (typeof timing?.wallClockMs === 'number') base.wallClockMs = nonNegInt(timing.wallClockMs, 0);
  if (typeof timing?.activeMs === 'number') base.activeMs = nonNegInt(timing.activeMs, 0);

  const segmentStart = toIsoOrNull(timing?.activeSegmentStartedAt);
  if (!segmentStart) {
    // 无 open segment，仅去掉字段
    return base;
  }
  const startMs = Date.parse(segmentStart);
  const endMs = Date.parse(nowIso);
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    base.activeAccumulatedMs += Math.max(0, endMs - startMs);
  }
  return base;
}

function openActiveSegment(timing, nowIso) {
  const base = {
    activeAccumulatedMs: nonNegInt(timing?.activeAccumulatedMs, 0),
    activeSegmentStartedAt: nowIso,
  };
  if (timing?.startedAt) base.startedAt = timing.startedAt;
  // 重新开跑时清掉终态字段
  return base;
}

/**
 * 按 plan 新状态推进时间账本。
 * - 首次进入 executing：写 startedAt + open segment
 * - pause / 终态：close segment；终态再落盘 wallClockMs/activeMs
 * - resume → executing：open segment（startedAt 不重置）
 *
 * @param {object|null|undefined} prevTiming
 * @param {string|undefined} prevStatus
 * @param {string} nextStatus
 * @param {string} [nowIso]
 * @returns {object|undefined}
 */
export function applyGoalTimingTransition(prevTiming, prevStatus, nextStatus, nowIso = new Date().toISOString()) {
  if (!nextStatus || prevStatus === nextStatus) {
    return normalizeGoalTiming(prevTiming);
  }

  let timing = normalizeGoalTiming(prevTiming) || { activeAccumulatedMs: 0 };
  const now = toIsoOrNull(nowIso) || new Date().toISOString();

  // 进入有效运行
  if (PLAN_ACTIVE_STATUSES.has(nextStatus)) {
    if (!timing.startedAt) timing.startedAt = now;
    // 从停表/草稿进入执行：开 segment；若已在跑且有 open segment 则保持
    if (!timing.activeSegmentStartedAt) {
      timing = openActiveSegment(timing, now);
    } else {
      // 清除终态字段（若从 failed 等恢复）
      const { completedAt: _c, wallClockMs: _w, activeMs: _a, ...rest } = timing;
      timing = rest;
    }
    return normalizeGoalTiming(timing);
  }

  // 停表（paused）
  if (PLAN_PAUSE_STATUSES.has(nextStatus)) {
    timing = closeActiveSegment(timing, now);
    return normalizeGoalTiming(timing);
  }

  // 终态
  if (PLAN_TERMINAL_STATUSES.has(nextStatus)) {
    timing = closeActiveSegment(timing, now);
    if (!timing.startedAt) {
      // 从未真正开跑就终态：不伪造 startedAt
      return normalizeGoalTiming({
        ...timing,
        completedAt: now,
        activeMs: nonNegInt(timing.activeAccumulatedMs, 0),
        wallClockMs: 0,
      });
    }
    const startedMs = Date.parse(timing.startedAt);
    const completedMs = Date.parse(now);
    const wallClockMs = Number.isFinite(startedMs) && Number.isFinite(completedMs)
      ? Math.max(0, completedMs - startedMs)
      : 0;
    return normalizeGoalTiming({
      ...timing,
      completedAt: now,
      activeMs: nonNegInt(timing.activeAccumulatedMs, 0),
      wallClockMs,
    });
  }

  // 其他状态（drafting / awaiting_approval / approved / accepted）：若有 open segment 则关掉
  // （例如从 executing 回退到 approved 的异常路径）
  if (timing.activeSegmentStartedAt) {
    timing = closeActiveSegment(timing, now);
  }
  return normalizeGoalTiming(timing);
}

/**
 * 按最终 Runner 状态校正 executing Goal 的 active segment。
 *
 * 这是 Runner → timing → 持久化的统一边界：调用方即使绕过 setRunnerState
 * 直接持久化 runner，也不能留下「活跃状态停表」或「暂停状态仍计时」的不一致。
 * 函数按最终状态幂等校正，因此也能在下一次写入时修复历史脏状态；只从
 * 当前写入时刻重新开表，不回填无法证明的历史有效时长。
 *
 * @param {object|null|undefined} prevTiming
 * @param {string|undefined} planStatus
 * @param {string|undefined} runnerStatus
 * @param {string} [nowIso]
 * @returns {object|undefined}
 */
function reconcileGoalTimingWithRunner(prevTiming, planStatus, runnerStatus, nowIso) {
  let timing = normalizeGoalTiming(prevTiming);
  if (planStatus !== 'executing') return timing;

  if (RUNNER_PAUSE_STATUSES.has(runnerStatus)) {
    if (timing?.activeSegmentStartedAt) {
      timing = applyGoalTimingTransition(timing, 'executing', 'paused', nowIso);
    }
    return timing;
  }

  if (RUNNER_ACTIVE_STATUSES.has(runnerStatus) && !timing?.activeSegmentStartedAt) {
    return applyGoalTimingTransition(timing, 'paused', 'executing', nowIso);
  }

  return timing;
}

/**
 * 自底向上聚合进度。约束（提案 §4）：
 * - 只统计叶子任务（无 subtasks 的任务）；父任务状态由叶子派生，不单独计数。
 * - completed / failed / blocked 分别计数，percent = completed / total * 100。
 *
 * @param {Array} tasks 顶层子任务树
 * @returns {{total:number,completed:number,failed:number,blocked:number,percent:number}}
 */
export function aggregateProgress(tasks) {
  let total = 0;
  let completed = 0;
  let failed = 0;
  let blocked = 0;

  const walk = (list) => {
    for (const t of list || []) {
      const children = Array.isArray(t.subtasks) ? t.subtasks : [];
      if (children.length > 0) {
        walk(children);
        continue;
      }
      // 叶子任务
      total += 1;
      if (t.status === TERMINAL_OK) completed += 1;
      else if (t.status === TERMINAL_FAIL) failed += 1;
      else if (t.status === BLOCKED) blocked += 1;
    }
  };
  walk(tasks);

  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { total, completed, failed, blocked, percent };
}

/**
 * 由子任务事实自底向上派生「计划整体状态」，与 aggregateProgress 同源（提案 §4/§6）。
 *
 * 规则：
 *
 * 1. 开工推进：当计划已处于「已批准」状态（approved），
 *    但已有任意子任务进入活跃或终态（running / completed / failed / waiting_user）时，
 *    说明执行已经开始，此时把计划推进到 'executing'，从而让审批相关 UI 正确收敛。
 *    注意：'awaiting_approval'（未批准）不在此规则的推进范围内——未批准计划即便
 *    出现活跃叶子，也不会被派生成 'executing'，以杜绝「顶层 executing 但从未批准、
 *    Runner 未启动」的僵死态。批准闸门只能由显式 recordApproval 打开。
 *
 * 2. 自动收尾：当计划已 'executing'（或可恢复的 'failed'）且存在叶子、且所有叶子均为
 *    终态（completed / failed / cancelled）时，把顶层推进到终态——含任一 failed → 'failed'，
 *    否则 completed + cancelled → 'completed'。waiting_user 不算终态；空计划不收尾。
 *
 * 3. 失败恢复：stream/runtime 中断可能把 plan 显式标成 'failed'，但子任务仍可能继续
 *    成功完成。若全部叶子已成功终态，则收尾为 'completed'（解除 failed 粘住）。
 *    未全部终态时保持 'failed'；继续执行需 resumeRunner / 用户续聊显式恢复为 executing。
 *    历史失败事件仍保留在 runTrace，不因状态恢复而抹掉。
 *
 * cancelled / paused / drafting 等显式态不由此函数回退改写。
 *
 * @param {string} currentStatus 当前 plan.status
 * @param {Array} tasks 顶层子任务树
 * @returns {string} 派生后的 plan.status
 */
export function derivePlanStatus(currentStatus, tasks) {
  const inspectLeaves = (list) => {
    let leafTotal = 0;
    let allTerminal = true;
    let hasFailed = false;
    let hasRunning = false;
    const walkLeaves = (nodes) => {
      for (const t of nodes || []) {
        const children = Array.isArray(t.subtasks) ? t.subtasks : [];
        if (children.length > 0) {
          walkLeaves(children);
          continue;
        }
        leafTotal += 1;
        if (t.status === TERMINAL_FAIL) hasFailed = true;
        else if (!LEAF_TERMINAL_STATUSES.has(t.status)) allTerminal = false;
        if (t.status === 'running') hasRunning = true;
      }
    };
    walkLeaves(list);
    return { leafTotal, allTerminal, hasFailed, hasRunning };
  };

  // 规则 2/3：executing 自动收尾；failed/interrupted 计划在叶子被显式重试为 running 时
  // 恢复执行，或在叶子事实已全部成功完成时恢复为 completed。未消费的 Runner interruption
  // 只在叶子仍未全部成功时把计划钉在 interrupted（ADR 73：可恢复挂起而非失败）；
  // 叶子已全部成功完成时，中断只是过期的 runner 事实，不能挡住 completed。
  // 重试预算耗尽的失败仍落 failed 终态。
  if (
    currentStatus === 'executing'
    || currentStatus === 'failed'
    || currentStatus === 'interrupted'
  ) {
    const { leafTotal, allTerminal, hasFailed, hasRunning } = inspectLeaves(tasks);
    if (leafTotal > 0 && allTerminal) {
      return hasFailed ? TERMINAL_FAIL : TERMINAL_OK;
    }
    if ((currentStatus === 'failed' || currentStatus === 'interrupted') && hasRunning) {
      return 'executing';
    }
    return currentStatus;
  }

  // 规则 1：approved/accepted + 已有活跃/终态叶子 → executing。
  // accepted 覆盖自驱 Goal（无 Plan 批准闸门）；drafting/awaiting_approval/paused/cancelled 等保持原样。
  if (currentStatus !== 'approved' && currentStatus !== 'accepted') return currentStatus;

  let started = false;
  const walk = (list) => {
    for (const t of list || []) {
      if (started) return;
      const children = Array.isArray(t.subtasks) ? t.subtasks : [];
      if (children.length > 0) {
        walk(children);
        continue;
      }
      if (
        t.status === 'running' ||
        t.status === TERMINAL_OK ||
        t.status === TERMINAL_FAIL ||
        t.status === TERMINAL_CANCEL ||
        t.status === BLOCKED
      ) {
        started = true;
        return;
      }
    }
  };
  walk(tasks);

  return started ? 'executing' : currentStatus;
}

/**
 * 在任务树里按 taskId 定位并以 updater 产生的新对象替换（不可变更新）。
 * @returns {{tasks:Array, found:boolean}}
 */
function updateTaskInTree(tasks, taskId, updater) {
  let found = false;
  const map = (list) =>
    (list || []).map((t) => {
      if (t.taskId === taskId) {
        found = true;
        return updater(t);
      }
      if (Array.isArray(t.subtasks) && t.subtasks.length > 0) {
        const next = map(t.subtasks);
        return { ...t, subtasks: next };
      }
      return t;
    });
  const next = map(tasks);
  return { tasks: next, found };
}

function taskExistsInTree(tasks, taskId) {
  if (!taskId) return false;
  const stack = Array.isArray(tasks) ? [...tasks] : [];
  while (stack.length > 0) {
    const task = stack.shift();
    if (!task || typeof task !== 'object') continue;
    if (task.taskId === taskId) return true;
    if (Array.isArray(task.subtasks)) {
      for (const child of task.subtasks) stack.push(child);
    }
  }
  return false;
}

function findTaskInTree(tasks, taskId) {
  if (!taskId) return null;
  const stack = Array.isArray(tasks) ? [...tasks] : [];
  while (stack.length > 0) {
    const task = stack.shift();
    if (!task || typeof task !== 'object') continue;
    if (task.taskId === taskId) return task;
    if (Array.isArray(task.subtasks)) {
      for (const child of task.subtasks) stack.push(child);
    }
  }
  return null;
}

const RUNNER_STATUSES = new Set([
  'idle',
  'running',
  'compacting_context',
  'resuming_after_compaction',
  'paused',
  'exploring',
  'waiting_user',
  'blocked',
  'budget_exhausted',
  'completed',
  'failed',
]);
const RUNNER_INTENTS = new Set(['execute', 'verify', 'explore', 'synthesize', 'block']);
const EXPLORER_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const EXPLORER_CONFIDENCE = new Set(['low', 'medium', 'high']);
const VERIFIER_STATUSES = new Set(['queued', 'running', 'passed', 'failed', 'blocked']);
const VERIFIER_TERMINAL_STATUSES = new Set(['passed', 'failed', 'blocked']);
const VERIFIER_TARGET_KINDS = new Set(['plan', 'task', 'success_criterion']);
const GOAL_RUN_EVENT_TYPES = new Set([
  'message_routed',
  'goal_intake_started',
  'goal_created',
  'plan_created',
  'plan_revised',
  'step_started',
  'step_completed',
  'action_started',
  'action_completed',
  'observation_recorded',
  'validation_started',
  'validation_passed',
  'validation_failed',
  'problem_found',
  'user_correction',
  'requirement_override',
  'self_correction',
  'checkpoint_created',
  'goal_checkpoint_prepared',
  'goal_checkpoint_committed',
  'goal_compaction_persisted',
  'goal_checkpoint_consumed',
  'goal_checkpoint_superseded',
  'network_interrupted',
  'goal_resumed',
  'child_goal_created',
  'child_goal_started',
  'child_goal_completed',
  'child_goal_failed',
  'parent_goal_resumed',
  'goal_paused',
  'goal_completed',
]);
const WORKFLOW_KINDS = new Set(['plan_approval', 'goal_self_driven']);
const ACTIVATION_KINDS = new Set(['intake', 'approval_required', 'approved_plan', 'accepted_goal']);
const INTAKE_RESOLUTIONS = new Set(['inquiry', 'clarifying', 'goal_confirmed']);
const AUTONOMY_KINDS = new Set(['approval_gated', 'self_driven']);
const WRITE_SCOPES = new Set(['workspace_and_boundaries']);
const CONFIRMATION_DECISIONS = new Set(['approve', 'reject', 'revise']);
const MANUAL_CONFIRMATION_KINDS = new Set(['manual_dod']);
const GOAL_RUNNER_PHASES = new Set([
  'orient',
  'inspect',
  'plan_scaffold',
  'act',
  'verify',
  'repair',
  'quality_review',
  'synthesize',
  'waiting_user',
  'blocked',
]);
const QUALITY_REVIEW_STATUSES = new Set(['reviewing', 'passed', 'failed']);
const QUALITY_CHECK_STATUSES = new Set(['passed', 'failed', 'skipped']);
const QUALITY_CHECK_IDS = new Set(['intent', 'mechanical', 'artifact', 'integration']);
const ASK_USER_REASONS = new Set([
  'ambiguous_goal',
  'product_decision',
  'high_risk',
  'irreversible',
  'missing_permission',
  'missing_credentials',
  'verification_conflict',
  'scope_drift',
]);

const DEFAULT_APPROVAL_GATED_POLICY = Object.freeze({
  autonomy: 'approval_gated',
  irreversibleRequiresConfirmation: true,
  writeScope: 'workspace_and_boundaries',
  askUserOn: [
    'ambiguous_goal',
    'product_decision',
    'high_risk',
    'irreversible',
    'missing_permission',
    'missing_credentials',
    'verification_conflict',
    'scope_drift',
  ],
});

const DEFAULT_SELF_DRIVEN_POLICY = Object.freeze({
  autonomy: 'self_driven',
  irreversibleRequiresConfirmation: true,
  writeScope: 'workspace_and_boundaries',
  askUserOn: [
    'ambiguous_goal',
    'product_decision',
    'high_risk',
    'irreversible',
    'missing_permission',
    'missing_credentials',
    'verification_conflict',
    'scope_drift',
  ],
});

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeEvidenceRefList(value) {
  if (typeof value === 'string') return normalizeStringArray([value]);
  return normalizeStringArray(value);
}

function normalizeEvidenceIndexRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const evidenceRef = normalizeOptionalString(value.evidenceRef);
  if (!evidenceRef) return null;
  const createdAt = normalizeOptionalString(value.createdAt) || new Date().toISOString();
  const record = { evidenceRef, createdAt };
  const optionalFields = [
    'planId',
    'conversationId',
    'streamId',
    'toolCallId',
    'capabilityId',
    'toolName',
  ];
  for (const field of optionalFields) {
    const normalized = normalizeOptionalString(value[field]);
    if (normalized) record[field] = normalized;
  }
  const artifactRefs = normalizeEvidenceRefList(value.artifactRefs);
  if (artifactRefs.length > 0) record.artifactRefs = artifactRefs;
  const userArtifacts = Array.isArray(value.userArtifacts)
    ? value.userArtifacts
      .filter((artifact) => artifact && typeof artifact === 'object')
      .map((artifact) => {
        const kind = ['code-change', 'file', 'image'].includes(artifact.kind) ? artifact.kind : null;
        const ref = normalizeOptionalString(artifact.ref);
        const label = normalizeOptionalString(artifact.label);
        if (!kind || !ref || !label) return null;
        const normalized = { kind, ref, label };
        const artifactPath = normalizeOptionalString(artifact.path);
        if (artifactPath) normalized.path = artifactPath;
        // 新建文件（kind='file'）同样带增删统计，因此不能只放行 code-change，
        // 否则「新建文件」这一类产物的 +N/−M 会在持久化这一层被丢掉。
        if ((kind === 'code-change' || kind === 'file') && artifact.preview?.kind === 'code') {
          const additions = Number.isSafeInteger(artifact.preview.additions) && artifact.preview.additions >= 0
            ? artifact.preview.additions
            : 0;
          const deletions = Number.isSafeInteger(artifact.preview.deletions) && artifact.preview.deletions >= 0
            ? artifact.preview.deletions
            : 0;
          const diffLines = Array.isArray(artifact.preview.diffLines)
            ? artifact.preview.diffLines
              .filter((line) => typeof line === 'string')
              .slice(0, 41)
              .map((line) => line.slice(0, 240))
            : [];
          if (diffLines.length > 0) normalized.preview = { kind: 'code', additions, deletions, diffLines };
        }
        if (kind === 'image' && artifact.preview?.kind === 'image') {
          const dataUrl = normalizeOptionalString(artifact.preview.dataUrl);
          const width = Number.isSafeInteger(artifact.preview.width) && artifact.preview.width > 0
            ? Math.min(640, artifact.preview.width)
            : 0;
          const height = Number.isSafeInteger(artifact.preview.height) && artifact.preview.height > 0
            ? Math.min(640, artifact.preview.height)
            : 0;
          if (dataUrl && dataUrl.length <= 512 * 1024
            && /^data:image\/(?:png|jpeg|webp);base64,/i.test(dataUrl)
            && width > 0 && height > 0) {
            normalized.preview = { kind: 'image', dataUrl, width, height };
          }
        }
        return normalized;
      })
      .filter(Boolean)
    : [];
  if (userArtifacts.length > 0) record.userArtifacts = userArtifacts;
  return record;
}

const EVIDENCE_WRAPPER_TOOL_NAMES = new Set(['goal_update_task']);

function mergeEvidenceIndexRecords(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;
  const merged = { ...current };
  for (const field of ['planId', 'conversationId', 'streamId']) {
    if (incoming[field]) merged[field] = incoming[field];
  }
  const currentIsWrapper = EVIDENCE_WRAPPER_TOOL_NAMES.has(current.toolName);
  const incomingIsWrapper = EVIDENCE_WRAPPER_TOOL_NAMES.has(incoming.toolName);
  if (!current.toolName || (currentIsWrapper && !incomingIsWrapper)) {
    for (const field of ['toolCallId', 'capabilityId', 'toolName']) {
      if (incoming[field]) merged[field] = incoming[field];
    }
    if (incoming.createdAt) merged.createdAt = incoming.createdAt;
  } else if (!incomingIsWrapper) {
    for (const field of ['toolCallId', 'capabilityId', 'toolName']) {
      if (!merged[field] && incoming[field]) merged[field] = incoming[field];
    }
  }
  const artifactRefs = normalizeEvidenceRefList([
    ...(current.artifactRefs ?? []),
    ...(incoming.artifactRefs ?? []),
  ]);
  if (artifactRefs.length > 0) merged.artifactRefs = artifactRefs;
  const userArtifacts = new Map();
  for (const artifact of [...(current.userArtifacts ?? []), ...(incoming.userArtifacts ?? [])]) {
    if (artifact?.ref) userArtifacts.set(artifact.ref, artifact);
  }
  if (userArtifacts.size > 0) merged.userArtifacts = [...userArtifacts.values()];
  return merged;
}

function normalizeWorkflowKind(value) {
  return WORKFLOW_KINDS.has(value) ? value : 'plan_approval';
}

function isSelfDrivenGoal(plan) {
  return plan?.workflowKind === 'goal_self_driven'
    || plan?.executionPolicy?.autonomy === 'self_driven'
    || plan?.activation?.kind === 'accepted_goal';
}

export function goalPlanIsSelfDriven(plan) {
  return isSelfDrivenGoal(plan);
}

export function goalPlanRequiresApproval(plan) {
  return !isSelfDrivenGoal(plan);
}

function defaultExecutionPolicyForWorkflow(workflowKind) {
  return workflowKind === 'goal_self_driven'
    ? DEFAULT_SELF_DRIVEN_POLICY
    : DEFAULT_APPROVAL_GATED_POLICY;
}

function normalizeActivation(value, workflowKind, status) {
  const now = new Date().toISOString();
  if (value && typeof value === 'object') {
    const kind = ACTIVATION_KINDS.has(value.kind) ? value.kind : null;
    if (kind) {
      const activation = { kind };
      if (typeof value.sourceMessageId === 'string' && value.sourceMessageId.trim()) {
        activation.sourceMessageId = value.sourceMessageId.trim();
      }
      if (typeof value.acceptedAt === 'string' && value.acceptedAt.trim()) {
        activation.acceptedAt = value.acceptedAt.trim();
      }
      if (typeof value.acceptedBy === 'string' && value.acceptedBy.trim()) {
        activation.acceptedBy = value.acceptedBy.trim();
      }
      if (INTAKE_RESOLUTIONS.has(value.intakeResolution)) {
        activation.intakeResolution = value.intakeResolution;
      }
      return activation;
    }
  }
  if (workflowKind === 'goal_self_driven') {
    return { kind: 'accepted_goal', acceptedAt: now, acceptedBy: 'user' };
  }
  if (status === 'approved' || status === 'executing' || status === 'paused') {
    return { kind: 'approved_plan' };
  }
  return { kind: 'approval_required' };
}

function normalizeExecutionPolicy(value, workflowKind) {
  const fallback = defaultExecutionPolicyForWorkflow(workflowKind);
  if (!value || typeof value !== 'object') return { ...fallback };
  const autonomy = AUTONOMY_KINDS.has(value.autonomy) ? value.autonomy : fallback.autonomy;
  const writeScope = WRITE_SCOPES.has(value.writeScope) ? value.writeScope : fallback.writeScope;
  const askUserOn = Array.isArray(value.askUserOn)
    ? value.askUserOn.filter((reason) => ASK_USER_REASONS.has(reason))
    : fallback.askUserOn;
  return {
    autonomy,
    irreversibleRequiresConfirmation:
      typeof value.irreversibleRequiresConfirmation === 'boolean'
        ? value.irreversibleRequiresConfirmation
        : fallback.irreversibleRequiresConfirmation,
    writeScope,
    askUserOn: askUserOn.length > 0 ? askUserOn : fallback.askUserOn,
  };
}

function makeDefaultGoalTask(goal) {
  return {
    taskId: 'orient',
    order: 0,
    title: goal
      ? '理清目标，拆出能验收的小步骤'
      : '理清目标',
    path: [],
    dependsOn: [],
    acceptanceCriteria: [],
    involvedFiles: [],
    status: 'pending',
    evidenceRefs: [],
  };
}

// 成功标准（DoD）的可选类型。command/test/file-contains/file-exists 可被机器自动
// 验证；manual 需人工确认。见 goal-mode-ultrathink-workflow 设计文档「DoD-as-Code」。
const CRITERION_KINDS = new Set(['command', 'test', 'file-contains', 'file-exists', 'manual']);
// 可自动验证的标准类型（完成门要求带 passed=true 的 CriterionResult）。
const AUTO_CRITERION_KINDS = new Set(['command', 'test', 'file-contains', 'file-exists']);

/**
 * 规范化单条成功标准（SuccessCriterion）。两种输入形态均向后兼容：
 * - 纯字符串 → 归一为 { id, kind:'manual', description }（旧计划/口头 DoD）
 * - 结构化对象 → 按 kind 保留可自动验证所需字段（command/path/expect）
 * 非法/空输入返回 null，由调用方过滤。
 */
function normalizeSuccessCriterion(value, index = 0) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    return { id: `c${index + 1}`, kind: 'manual', description: text };
  }
  if (!value || typeof value !== 'object') return null;
  const rawKind = typeof value.kind === 'string' ? value.kind.trim() : '';
  const kind = CRITERION_KINDS.has(rawKind) ? rawKind : 'manual';
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `c${index + 1}`;
  let description = typeof value.description === 'string' ? value.description.trim() : '';
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  const targetPath = typeof value.path === 'string' ? value.path.trim() : '';
  const expect = typeof value.expect === 'string' ? value.expect.trim() : '';
  if (!description) {
    // 无描述时用可用字段兜底，保证渲染/审计可读。
    description = command || targetPath || '(unnamed criterion)';
  }
  const criterion = { id, kind, description };
  if (command) criterion.command = command;
  if (targetPath) criterion.path = targetPath;
  if (expect) criterion.expect = expect;
  return criterion;
}

function normalizeSuccessCriteria(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => normalizeSuccessCriterion(item, index)).filter(Boolean);
}

/**
 * 规范化单条验证结果（CriterionResult）。每条对应一个 successCriterion.id，
 * 记录该标准是否通过、佐证的 evidenceRef 与检查详情。缺 criterionId 视为非法。
 */
function normalizeCriterionResult(value) {
  if (!value || typeof value !== 'object') return null;
  const criterionId = typeof value.criterionId === 'string' ? value.criterionId.trim() : '';
  if (!criterionId) return null;
  const result = { criterionId, passed: value.passed === true };
  if (typeof value.evidenceRef === 'string' && value.evidenceRef.trim()) {
    result.evidenceRef = value.evidenceRef.trim();
  }
  if (typeof value.detail === 'string' && value.detail.trim()) {
    result.detail = value.detail.trim();
  }
  if (typeof value.checkedAt === 'string' && value.checkedAt.trim()) {
    result.checkedAt = value.checkedAt.trim();
  }
  return result;
}

function normalizeCriterionResults(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeCriterionResult(item)).filter(Boolean);
}

function normalizeManualConfirmation(value) {
  if (!value || typeof value !== 'object') return null;
  const kind = MANUAL_CONFIRMATION_KINDS.has(value.kind) ? value.kind : null;
  const decision = CONFIRMATION_DECISIONS.has(value.decision) ? value.decision : null;
  const criterionIds = normalizeStringArray(value.criterionIds);
  if (!kind || !decision || criterionIds.length === 0) return null;
  const confirmationId = typeof value.confirmationId === 'string' && value.confirmationId.trim()
    ? value.confirmationId.trim()
    : randomUUID();
  const decidedAt = typeof value.decidedAt === 'string' && value.decidedAt.trim()
    ? value.decidedAt.trim()
    : new Date().toISOString();
  const confirmation = {
    confirmationId,
    kind,
    decision,
    criterionIds,
    decidedAt,
  };
  if (typeof value.decidedBy === 'string' && value.decidedBy.trim()) {
    confirmation.decidedBy = value.decidedBy.trim();
  }
  if (typeof value.feedback === 'string' && value.feedback.trim()) {
    confirmation.feedback = value.feedback.trim();
  }
  return confirmation;
}

function normalizeManualConfirmations(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeManualConfirmation(item)).filter(Boolean);
}

function collectManualCriterionIds(plan) {
  return (Array.isArray(plan?.successCriteria) ? plan.successCriteria : [])
    .filter((criterion) => criterion && typeof criterion === 'object')
    .filter((criterion) => !AUTO_CRITERION_KINDS.has(criterion.kind))
    .map((criterion) => (typeof criterion.id === 'string' ? criterion.id.trim() : ''))
    .filter(Boolean);
}

function normalizeExplorerRequest(request, fallback = {}) {
  const now = new Date().toISOString();
  const explorerId = typeof request?.explorerId === 'string' && request.explorerId.trim()
    ? request.explorerId.trim()
    : fallback.explorerId;
  const planId = typeof request?.planId === 'string' && request.planId.trim()
    ? request.planId.trim()
    : fallback.planId;
  if (!explorerId || !planId) return null;
  const scope = request?.scope && typeof request.scope === 'object'
    ? {
        include: normalizeStringArray(request.scope.include),
        exclude: normalizeStringArray(request.scope.exclude),
      }
    : undefined;
  const normalized = {
    explorerId,
    planId,
    question: typeof request?.question === 'string' && request.question.trim()
      ? request.question.trim()
      : '为当前目标补齐缺失的信息',
    reason: typeof request?.reason === 'string' && request.reason.trim()
      ? request.reason.trim()
      : '需要先只读查一下资料',
    profile: 'readonly_explorer',
    budget: {
      maxToolCalls: Number.isFinite(request?.budget?.maxToolCalls)
        ? Math.max(1, Math.trunc(request.budget.maxToolCalls))
        : Number.isFinite(request?.maxToolCalls)
          ? Math.max(1, Math.trunc(request.maxToolCalls))
          : 8,
      maxDurationMs: Number.isFinite(request?.budget?.maxDurationMs)
        ? Math.max(1000, Math.trunc(request.budget.maxDurationMs))
        : Number.isFinite(request?.maxDurationMs)
          ? Math.max(1000, Math.trunc(request.maxDurationMs))
          : 120000,
    },
    exitCriteria: normalizeStringArray(request?.exitCriteria),
    createdAt: typeof request?.createdAt === 'string' && request.createdAt.trim()
      ? request.createdAt
      : now,
  };
  if (scope && (scope.include.length > 0 || scope.exclude.length > 0)) normalized.scope = scope;
  return normalized;
}

function normalizeExplorerReport(report, fallback = {}) {
  if (!report || typeof report !== 'object') return undefined;
  const explorerId = typeof report.explorerId === 'string' && report.explorerId.trim()
    ? report.explorerId.trim()
    : fallback.explorerId;
  const planId = typeof report.planId === 'string' && report.planId.trim()
    ? report.planId.trim()
    : fallback.planId;
  if (!explorerId || !planId) return undefined;
  const findings = Array.isArray(report.findings)
    ? report.findings
        .map((finding) => ({
          claim: typeof finding?.claim === 'string' ? finding.claim.trim() : '',
          evidenceRefs: normalizeStringArray(finding?.evidenceRefs),
        }))
        .filter((finding) => finding.claim && finding.evidenceRefs.length > 0)
    : [];
  const normalized = {
    explorerId,
    planId,
    question: typeof report.question === 'string' && report.question.trim()
      ? report.question.trim()
      : fallback.question || '',
    findings,
    evidenceRefs: normalizeStringArray(report.evidenceRefs),
    confidence: EXPLORER_CONFIDENCE.has(report.confidence) ? report.confidence : 'low',
  };
  if (typeof report.recommendedNextAction === 'string' && report.recommendedNextAction.trim()) {
    normalized.recommendedNextAction = report.recommendedNextAction.trim();
  }
  if (typeof report.blockedReason === 'string' && report.blockedReason.trim()) {
    normalized.blockedReason = report.blockedReason.trim();
  }
  return normalized;
}

function collectExplorerReportEvidenceRefs(report) {
  const refs = new Set();
  for (const ref of normalizeStringArray(report?.evidenceRefs)) refs.add(ref);
  for (const finding of Array.isArray(report?.findings) ? report.findings : []) {
    for (const ref of normalizeStringArray(finding?.evidenceRefs)) refs.add(ref);
  }
  return Array.from(refs);
}

function normalizeExplorerRegistryRefs(report, existingRun = {}) {
  const explicit =
    report?.allowedEvidenceRefs ??
    report?.registeredEvidenceRefs ??
    report?.toolEvidenceRefs ??
    report?.evidenceRegistry;
  const refs = explicit !== undefined ? explicit : existingRun.evidenceRefs;
  return normalizeStringArray(refs);
}

function assertExplorerReportEvidenceRegistered({ explorerId, report, registeredRefs }) {
  if (!report || report.evidenceRefs.length === 0) {
    throw new Error(
      `[goal-plan-store] explorer ${explorerId} cannot be 'completed' without evidenceRefs`,
    );
  }
  if (registeredRefs.length === 0) {
    throw new Error(
      `[goal-plan-store] explorer ${explorerId} cannot be 'completed' without registered tool evidenceRefs`,
    );
  }
  const registered = new Set(registeredRefs);
  const unknown = collectExplorerReportEvidenceRefs(report).filter((ref) => !registered.has(ref));
  if (unknown.length > 0) {
    throw new Error(
      `[goal-plan-store] explorer ${explorerId} reported unregistered evidenceRefs: ${unknown.join(', ')}`,
    );
  }
}

function normalizeExplorerRun(run, fallback = {}) {
  if (!run || typeof run !== 'object') return null;
  const explorerId = typeof run.explorerId === 'string' && run.explorerId.trim()
    ? run.explorerId.trim()
    : fallback.explorerId;
  const request = normalizeExplorerRequest(run.request, { explorerId, planId: fallback.planId });
  if (!request) return null;
  const now = new Date().toISOString();
  const status = EXPLORER_STATUSES.has(run.status) ? run.status : 'queued';
  const normalized = {
    explorerId: request.explorerId,
    status,
    request,
    createdAt: typeof run.createdAt === 'string' && run.createdAt.trim() ? run.createdAt : request.createdAt,
    updatedAt: typeof run.updatedAt === 'string' && run.updatedAt.trim() ? run.updatedAt : now,
  };
  const report = normalizeExplorerReport(run.report, {
    explorerId: request.explorerId,
    planId: request.planId,
    question: request.question,
  });
  if (report) normalized.report = report;
  const evidenceRefs = normalizeStringArray(run.evidenceRefs);
  if (evidenceRefs.length > 0) normalized.evidenceRefs = evidenceRefs;
  if (typeof run.failureReason === 'string' && run.failureReason.trim()) {
    normalized.failureReason = run.failureReason.trim();
  }
  const batchId = typeof run.batchId === 'string' && run.batchId.trim()
    ? run.batchId.trim()
    : (typeof fallback.batchId === 'string' && fallback.batchId.trim() ? fallback.batchId.trim() : undefined);
  if (batchId) normalized.batchId = batchId;
  return normalized;
}

function normalizeExploreQuestion(question) {
  if (!question || typeof question !== 'object') return null;
  const text = typeof question.question === 'string' && question.question.trim()
    ? question.question.trim()
    : '';
  if (!text) return null;
  const reason = typeof question.reason === 'string' && question.reason.trim()
    ? question.reason.trim()
    : 'Deterministic inspect requires more read-only evidence before acting';
  const normalized = { question: text, reason };
  const include = normalizeStringArray(question.scope?.include);
  const exclude = normalizeStringArray(question.scope?.exclude);
  if (include.length > 0 || exclude.length > 0) {
    normalized.scope = {
      ...(include.length > 0 ? { include } : {}),
      ...(exclude.length > 0 ? { exclude } : {}),
    };
  }
  const budget = question.budget && typeof question.budget === 'object' ? question.budget : {};
  const normalizedBudget = {};
  if (Number.isFinite(budget.maxToolCalls)) {
    normalizedBudget.maxToolCalls = Math.max(1, Math.trunc(budget.maxToolCalls));
  }
  if (Number.isFinite(budget.maxDurationMs)) {
    normalizedBudget.maxDurationMs = Math.max(1000, Math.trunc(budget.maxDurationMs));
  }
  if (Object.keys(normalizedBudget).length > 0) normalized.budget = normalizedBudget;
  return normalized;
}

function normalizeExplorePlan(plan) {
  if (!plan || typeof plan !== 'object') return undefined;
  const questions = Array.isArray(plan.questions)
    ? plan.questions.map(normalizeExploreQuestion).filter(Boolean)
    : [];
  const generatedAt = typeof plan.generatedAt === 'string' && plan.generatedAt.trim()
    ? plan.generatedAt.trim()
    : new Date().toISOString();
  return {
    requiredBeforeAct: Boolean(plan.requiredBeforeAct) && questions.length > 0,
    questions,
    exitCriteria: normalizeStringArray(plan.exitCriteria),
    generatedAt,
  };
}

function countExplorerRuns(explorers) {
  return Array.isArray(explorers) ? explorers.filter(Boolean).length : 0;
}

const EXPLORER_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// 依据某个 batchId，从 explorers 列表推导「本轮」并发进度：
// total = 属于该 batch 的 Explorer 总数（分母），done = 其中已进入终止态的数量（分子）。
// 幂等：dispatch / report 任意时刻调用都能得到与当前列表一致的进度。
function computeExplorerBatch(explorers, batchId) {
  if (!batchId) return undefined;
  const runs = (Array.isArray(explorers) ? explorers : []).filter(
    (run) => run && run.batchId === batchId,
  );
  if (runs.length === 0) return undefined;
  const done = runs.filter((run) => EXPLORER_TERMINAL_STATUSES.has(run.status)).length;
  return { batchId, total: runs.length, done };
}

function normalizeVerifierTarget(target, fallback = {}) {
  const source = target && typeof target === 'object' ? target : {};
  const rawKind = typeof source.kind === 'string' && source.kind.trim()
    ? source.kind.trim()
    : fallback.kind;
  const inferredKind = typeof source.criterionId === 'string' && source.criterionId.trim()
    ? 'success_criterion'
    : typeof source.taskId === 'string' && source.taskId.trim()
      ? 'task'
      : 'plan';
  const kind = VERIFIER_TARGET_KINDS.has(rawKind) ? rawKind : inferredKind;
  const normalized = { kind };
  if (kind === 'task') {
    const taskId = typeof source.taskId === 'string' && source.taskId.trim()
      ? source.taskId.trim()
      : fallback.taskId;
    if (!taskId) return null;
    normalized.taskId = taskId;
  } else if (kind === 'success_criterion') {
    const criterionId = typeof source.criterionId === 'string' && source.criterionId.trim()
      ? source.criterionId.trim()
      : fallback.criterionId;
    if (!criterionId) return null;
    normalized.criterionId = criterionId;
  }
  return normalized;
}

function normalizeVerifierIssue(issue) {
  if (!issue || typeof issue !== 'object') return null;
  const reason = typeof issue.reason === 'string' && issue.reason.trim()
    ? issue.reason.trim()
    : '';
  if (!reason) return null;
  const normalized = {
    reason,
    evidenceRefs: normalizeStringArray(issue.evidenceRefs),
  };
  if (typeof issue.taskId === 'string' && issue.taskId.trim()) {
    normalized.taskId = issue.taskId.trim();
  }
  if (typeof issue.criterionId === 'string' && issue.criterionId.trim()) {
    normalized.criterionId = issue.criterionId.trim();
  }
  return normalized;
}

function normalizeVerifierReport(report) {
  if (!report || typeof report !== 'object') return undefined;
  return {
    passed: report.passed === true,
    failedCriteria: Array.isArray(report.failedCriteria)
      ? report.failedCriteria.map(normalizeVerifierIssue).filter(Boolean)
      : [],
    missingEvidence: Array.isArray(report.missingEvidence)
      ? report.missingEvidence.map(normalizeVerifierIssue).filter(Boolean)
      : [],
    risks: normalizeStringArray(report.risks),
    evidenceRefs: normalizeStringArray(report.evidenceRefs),
    ...(typeof report.recommendedNextAction === 'string' && report.recommendedNextAction.trim()
      ? { recommendedNextAction: report.recommendedNextAction.trim() }
      : {}),
  };
}

function normalizeVerifierRun(run, fallback = {}) {
  if (!run || typeof run !== 'object') return null;
  const verifierRunId = typeof run.verifierRunId === 'string' && run.verifierRunId.trim()
    ? run.verifierRunId.trim()
    : fallback.verifierRunId;
  const planId = typeof run.planId === 'string' && run.planId.trim()
    ? run.planId.trim()
    : fallback.planId;
  if (!verifierRunId || !planId) return null;
  const now = new Date().toISOString();
  const target = normalizeVerifierTarget(run.target ?? run, fallback.target);
  if (!target) return null;
  const status = VERIFIER_STATUSES.has(run.status) ? run.status : 'queued';
  const normalized = {
    verifierRunId,
    planId,
    target,
    status,
    evidenceRefs: normalizeStringArray(run.evidenceRefs),
    createdAt: typeof run.createdAt === 'string' && run.createdAt.trim() ? run.createdAt : now,
    updatedAt: typeof run.updatedAt === 'string' && run.updatedAt.trim() ? run.updatedAt : now,
  };
  const report = normalizeVerifierReport(run.report);
  if (report) {
    normalized.report = report;
    if (normalized.evidenceRefs.length === 0 && report.evidenceRefs.length > 0) {
      normalized.evidenceRefs = report.evidenceRefs;
    }
  }
  if (typeof run.summary === 'string' && run.summary.trim()) {
    normalized.summary = run.summary.trim();
  }
  if (typeof run.failureReason === 'string' && run.failureReason.trim()) {
    normalized.failureReason = run.failureReason.trim();
  }
  if (typeof run.completedAt === 'string' && run.completedAt.trim()) {
    normalized.completedAt = run.completedAt.trim();
  } else if (VERIFIER_TERMINAL_STATUSES.has(status)) {
    normalized.completedAt = now;
  }
  return normalized;
}

function normalizeRunEvent(event, fallback = {}) {
  if (!event || typeof event !== 'object') return null;
  const goalPlanId = normalizeOptionalString(event.goalPlanId) || normalizeOptionalString(fallback.goalPlanId);
  const type = GOAL_RUN_EVENT_TYPES.has(event.type) ? event.type : null;
  if (!goalPlanId || !type) return null;
  const now = new Date().toISOString();
  const normalized = {
    id: normalizeOptionalString(event.id) || randomUUID(),
    goalPlanId,
    type,
    summary: normalizeOptionalString(event.summary) || type,
    evidenceRefs: normalizeEvidenceRefList(event.evidenceRefs),
    createdAt: normalizeOptionalString(event.createdAt) || now,
  };
  const nodeId = normalizeOptionalString(event.nodeId);
  if (nodeId) normalized.nodeId = nodeId;
  const parentNodeId = normalizeOptionalString(event.parentNodeId);
  if (parentNodeId) normalized.parentNodeId = parentNodeId;
  if (event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)) {
    normalized.payload = event.payload;
  }
  return normalized;
}

function normalizeRunTrace(trace, fallback = {}) {
  const events = Array.isArray(trace?.events)
    ? trace.events.map((event) => normalizeRunEvent(event, fallback)).filter(Boolean)
    : [];
  const normalized = { events };
  const activeNodeId = normalizeOptionalString(trace?.activeNodeId);
  if (activeNodeId) normalized.activeNodeId = activeNodeId;
  const lastCheckpointNodeId = normalizeOptionalString(trace?.lastCheckpointNodeId);
  if (lastCheckpointNodeId) normalized.lastCheckpointNodeId = lastCheckpointNodeId;
  return normalized;
}

const ACTIVE_PLAN_STATUSES = new Set(['drafting', 'awaiting_approval', 'approved', 'accepted', 'executing', 'paused', 'interrupted', 'failed']);

function normalizeConversationId(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

// 目标要改动的代码仓绝对路径（可与会话工作区不同，例如"知识库驱动代码库"场景）。
// 归一化镜像 normalizeConversationId：trim 后空串归一为 null，供 Explorer 派发时注入。
function normalizeWorkspacePath(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

const TARGET_BRANCH_SOURCES = new Set(['user_confirmed', 'workspace_head', 'preconfigured']);
const EXECUTION_ISOLATIONS = new Set(['none', 'worktree']);

/** Trim a non-empty string. Never invent a default such as `main`. */
function normalizeQualityReview(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (!QUALITY_REVIEW_STATUSES.has(value.status)) return undefined;
  const checks = Array.isArray(value.checks)
    ? value.checks
      .map((check) => {
        if (!check || typeof check !== 'object') return null;
        if (!QUALITY_CHECK_IDS.has(check.id) || !QUALITY_CHECK_STATUSES.has(check.status)) return null;
        const label = typeof check.label === 'string' && check.label.trim()
          ? check.label.trim()
          : check.id;
        const next = { id: check.id, label, status: check.status };
        if (typeof check.note === 'string' && check.note.trim()) next.note = check.note.trim();
        return next;
      })
      .filter(Boolean)
    : [];
  const review = { status: value.status };
  if (typeof value.reviewedAt === 'string' && value.reviewedAt.trim()) {
    review.reviewedAt = value.reviewedAt.trim();
  }
  if (checks.length > 0) review.checks = checks;
  return review;
}

const DELIVERY_HANDOFF_STATUSES = new Set(['idle', 'delivering', 'delivered', 'stopped']);
const DELIVERY_MODES = new Set(['merge', 'direct']);

function normalizeDeliveryHandoff(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (!DELIVERY_HANDOFF_STATUSES.has(value.status)) return undefined;
  const handoff = { status: value.status };
  // ADR 68：交付模式；缺省 merge（存量数据无此字段）。
  if (DELIVERY_MODES.has(value.deliveryMode)) handoff.deliveryMode = value.deliveryMode;
  const repoId = normalizeOptionalName(value.repoId);
  if (repoId) handoff.repoId = repoId;
  const targetBranch = normalizeOptionalName(value.targetBranch);
  if (targetBranch) handoff.targetBranch = targetBranch;
  const taskBranch = normalizeOptionalName(value.taskBranch);
  if (taskBranch) handoff.taskBranch = taskBranch;
  const commitSha = normalizeOptionalName(value.commitSha);
  if (commitSha) handoff.commitSha = commitSha;
  const stoppedReason = normalizeOptionalName(value.stoppedReason);
  if (stoppedReason) handoff.stoppedReason = stoppedReason;
  if (typeof value.updatedAt === 'string' && value.updatedAt.trim()) {
    handoff.updatedAt = value.updatedAt.trim();
  }
  return handoff;
}

function normalizeOptionalName(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeTargetBranchSource(value) {
  if (typeof value !== 'string') return undefined;
  return TARGET_BRANCH_SOURCES.has(value) ? value : undefined;
}

function normalizeExecutionIsolation(value) {
  if (typeof value !== 'string') return undefined;
  return EXECUTION_ISOLATIONS.has(value) ? value : undefined;
}

/**
 * Persist an explicit delivery binding only. Missing branch / source means
 * unbound — do not fall back to main or the origin workspace branch.
 */
function normalizeDeliveryBinding(value, fallbacks = {}) {
  if (!value || typeof value !== 'object') return undefined;
  const repoId = normalizeOptionalName(value.repoId);
  const targetBranch = normalizeOptionalName(value.targetBranch);
  const targetBranchSource = normalizeTargetBranchSource(value.targetBranchSource);
  if (!repoId || !targetBranch || !targetBranchSource) return undefined;
  const binding = {
    repoId,
    targetBranch,
    targetBranchSource,
    executionIsolation: normalizeExecutionIsolation(value.executionIsolation) || 'none',
    boundAt: typeof value.boundAt === 'string' && value.boundAt.trim()
      ? value.boundAt.trim()
      : (fallbacks.boundAt || new Date().toISOString()),
  };
  const targetWorkspacePath = normalizeWorkspacePath(value.targetWorkspacePath)
    ?? normalizeWorkspacePath(fallbacks.targetWorkspacePath);
  if (targetWorkspacePath) binding.targetWorkspacePath = targetWorkspacePath;
  const baseCommit = normalizeOptionalName(value.baseCommit) ?? normalizeOptionalName(fallbacks.baseCommit);
  if (baseCommit) binding.baseCommit = baseCommit;
  const taskBranch = normalizeOptionalName(value.taskBranch);
  if (taskBranch) binding.taskBranch = taskBranch;
  const worktreePath = normalizeWorkspacePath(value.worktreePath);
  if (worktreePath) binding.worktreePath = worktreePath;
  return binding;
}

function normalizeRunnerState(runner, planId) {
  if (!runner || typeof runner !== 'object') return undefined;
  const now = new Date().toISOString();
  const status = RUNNER_STATUSES.has(runner.status) ? runner.status : 'idle';
  const next = {
    enabled: Boolean(runner.enabled),
    status,
    turnCount: Number.isFinite(runner.turnCount) ? Math.max(0, Math.trunc(runner.turnCount)) : 0,
    roundCount: Number.isFinite(runner.roundCount) ? Math.max(0, Math.trunc(runner.roundCount)) : 0,
    toolCallCount: Number.isFinite(runner.toolCallCount) ? Math.max(0, Math.trunc(runner.toolCallCount)) : 0,
    explorerCount: Number.isFinite(runner.explorerCount) ? Math.max(0, Math.trunc(runner.explorerCount)) : 0,
    maxTurns: Number.isFinite(runner.maxTurns) ? Math.max(1, Math.trunc(runner.maxTurns)) : 8,
    maxToolCalls: Number.isFinite(runner.maxToolCalls) ? Math.max(1, Math.trunc(runner.maxToolCalls)) : 40,
    maxExplorers: Number.isFinite(runner.maxExplorers)
      ? Math.min(MAX_EXPLORERS_HARD_CAP, Math.max(0, Math.trunc(runner.maxExplorers)))
      : 3,
    explorerConcurrency: Number.isFinite(runner.explorerConcurrency)
      ? Math.min(EXPLORER_CONCURRENCY_HARD_CAP, Math.max(1, Math.trunc(runner.explorerConcurrency)))
      : DEFAULT_EXPLORER_CONCURRENCY,
    updatedAt: typeof runner.updatedAt === 'string' && runner.updatedAt.trim() ? runner.updatedAt : now,
  };
  if (RUNNER_INTENTS.has(runner.intent)) {
    next.intent = runner.intent;
  }
  if (GOAL_RUNNER_PHASES.has(runner.phase)) {
    next.phase = runner.phase;
  }
  if (typeof runner.currentTaskId === 'string' && runner.currentTaskId.trim()) {
    next.currentTaskId = runner.currentTaskId.trim();
  }
  if (typeof runner.runId === 'string' && runner.runId.trim()) {
    next.runId = runner.runId.trim();
  }
  if (runner.interruption && typeof runner.interruption === 'object') {
    const source = typeof runner.interruption.source === 'string'
      ? runner.interruption.source.trim()
      : '';
    const reason = typeof runner.interruption.reason === 'string'
      ? runner.interruption.reason.trim()
      : '';
    const interruptedAt = typeof runner.interruption.interruptedAt === 'string'
      ? runner.interruption.interruptedAt.trim()
      : '';
    if (source && reason && interruptedAt) {
      next.interruption = {
        source,
        reason,
        interruptedAt,
        recoverable: runner.interruption.recoverable === true,
        attempt: Number.isFinite(runner.interruption.attempt)
          ? Math.max(1, Math.trunc(runner.interruption.attempt))
          : 1,
      };
    }
  }
  if (Number.isFinite(runner.recoverableInterruptionCount)) {
    next.recoverableInterruptionCount = Math.max(0, Math.trunc(runner.recoverableInterruptionCount));
  }
  if (Number.isFinite(runner.maxRecoverableInterruptionRetries)) {
    next.maxRecoverableInterruptionRetries = Math.max(0, Math.trunc(runner.maxRecoverableInterruptionRetries));
  }
  if (Number.isFinite(runner.compactionCount)) {
    next.compactionCount = Math.max(0, Math.trunc(runner.compactionCount));
  }
  if (typeof runner.lastCompactionAt === 'string' && runner.lastCompactionAt.trim()) {
    next.lastCompactionAt = runner.lastCompactionAt.trim();
  }
  if (typeof runner.lastConsumedCheckpointId === 'string' && runner.lastConsumedCheckpointId.trim()) {
    next.lastConsumedCheckpointId = runner.lastConsumedCheckpointId.trim();
  }
  if (Number.isFinite(runner.lastConsumedCheckpointSequence)) {
    next.lastConsumedCheckpointSequence = Math.max(0, Math.trunc(runner.lastConsumedCheckpointSequence));
  }
  if (runner.contextCheckpoint && typeof runner.contextCheckpoint === 'object') {
    try {
      next.contextCheckpoint = normalizeGoalCheckpoint(runner.contextCheckpoint, {
        fallbackPlanId: planId,
        fallbackRunId: next.runId || planId,
        now,
      });
    } catch {
      // Keep raw invalid checkpoint out of runtime state; recovery paths rebuild it.
    }
  }
  if (runner.blockerAudit && typeof runner.blockerAudit === 'object') {
    const fingerprint = typeof runner.blockerAudit.fingerprint === 'string'
      ? runner.blockerAudit.fingerprint.trim()
      : '';
    const reason = typeof runner.blockerAudit.reason === 'string'
      ? runner.blockerAudit.reason.trim()
      : '';
    if (fingerprint && reason) {
      next.blockerAudit = {
        fingerprint,
        reason,
        occurrences: Number.isFinite(runner.blockerAudit.occurrences)
          ? Math.max(1, Math.trunc(runner.blockerAudit.occurrences))
          : 1,
        firstSeenAt: typeof runner.blockerAudit.firstSeenAt === 'string' && runner.blockerAudit.firstSeenAt.trim()
          ? runner.blockerAudit.firstSeenAt.trim()
          : now,
        lastSeenAt: typeof runner.blockerAudit.lastSeenAt === 'string' && runner.blockerAudit.lastSeenAt.trim()
          ? runner.blockerAudit.lastSeenAt.trim()
          : now,
      };
    }
  }
  if (Number.isFinite(runner.tokenBudget)) {
    next.tokenBudget = Math.max(0, Math.trunc(runner.tokenBudget));
  }
  if (Number.isFinite(runner.tokenUsed)) {
    next.tokenUsed = Math.max(0, Math.trunc(runner.tokenUsed));
  }
  if (typeof runner.blockedReason === 'string' && runner.blockedReason.trim()) {
    next.blockedReason = runner.blockedReason.trim();
  }
  if (Array.isArray(runner.explorers)) {
    const explorers = runner.explorers
      .map((run) => normalizeExplorerRun(run, { planId }))
      .filter(Boolean);
    if (explorers.length > 0) next.explorers = explorers;
  }
  if (Array.isArray(runner.verifierRuns)) {
    const verifierRuns = runner.verifierRuns
      .map((run) => normalizeVerifierRun(run, { planId }))
      .filter(Boolean);
    if (verifierRuns.length > 0) next.verifierRuns = verifierRuns;
  }
  if (runner.explorerBatch && typeof runner.explorerBatch === 'object') {
    const batchId = typeof runner.explorerBatch.batchId === 'string' && runner.explorerBatch.batchId.trim()
      ? runner.explorerBatch.batchId.trim()
      : undefined;
    const total = Number.isFinite(runner.explorerBatch.total)
      ? Math.max(0, Math.trunc(runner.explorerBatch.total))
      : 0;
    const done = Number.isFinite(runner.explorerBatch.done)
      ? Math.max(0, Math.min(total, Math.trunc(runner.explorerBatch.done)))
      : 0;
    if (batchId && total > 0) {
      next.explorerBatch = { batchId, total, done };
    }
  }
  const inspectPlan = normalizeExplorePlan(runner.inspectPlan);
  if (inspectPlan) next.inspectPlan = inspectPlan;
  if (typeof runner.lastError === 'string' && runner.lastError.trim()) {
    next.lastError = runner.lastError.trim();
  }
  return next;
}

function normalizePlan(plan) {
  if (!plan) return null;
  const normalizedConversationId = normalizeConversationId(plan.conversationId);
  const approvalDecision = plan.approval?.decision;
  const normalizedStatus = approvalDecision === 'reject' && plan.status !== 'cancelled'
    ? 'cancelled'
    : plan.status;
  const workflowKind = normalizeWorkflowKind(plan.workflowKind);
  const normalized = {
    ...plan,
    conversationId: normalizedConversationId ?? undefined,
    originWorkspacePath: normalizeWorkspacePath(plan.originWorkspacePath) ?? undefined,
    targetWorkspacePath: normalizeWorkspacePath(plan.targetWorkspacePath) ?? undefined,
    targetRepoId: normalizeOptionalName(plan.targetRepoId) ?? normalizeOptionalName(plan.deliveryBinding?.repoId),
    targetBranch: normalizeOptionalName(plan.targetBranch) ?? normalizeOptionalName(plan.deliveryBinding?.targetBranch),
    baseCommit: normalizeOptionalName(plan.baseCommit) ?? normalizeOptionalName(plan.deliveryBinding?.baseCommit),
    targetBranchSource: normalizeTargetBranchSource(plan.targetBranchSource)
      ?? normalizeTargetBranchSource(plan.deliveryBinding?.targetBranchSource),
    deliveryBinding: normalizeDeliveryBinding(plan.deliveryBinding, {
      targetWorkspacePath: plan.targetWorkspacePath,
      baseCommit: plan.baseCommit,
    }),
    workflowKind,
    activation: normalizeActivation(plan.activation, workflowKind, normalizedStatus),
    executionPolicy: normalizeExecutionPolicy(plan.executionPolicy, workflowKind),
    status: normalizedStatus,
    // 读路径降级：存量计划的 successCriteria 可能是纯字符串数组或缺字段，
    // 统一归一为结构化 SuccessCriterion[]；criterionResults 缺失时补空数组。
    // 不破坏旧计划，保证下游（完成门 / 提示词渲染）拿到一致形态。
    successCriteria: normalizeSuccessCriteria(plan.successCriteria),
    criterionResults: normalizeCriterionResults(plan.criterionResults),
    manualConfirmations: normalizeManualConfirmations(plan.manualConfirmations),
    qualityReview: normalizeQualityReview(plan.qualityReview),
    deliveryHandoff: normalizeDeliveryHandoff(plan.deliveryHandoff),
  };
  // 读路径只恢复「叶子已全部成功，但计划仍钉在 interrupted/failed」的过期记录。
  // 不能对所有状态全量派生，否则 completed intake 被 markRequestedUserInput
  // 重新打开后，读盘会立刻打回 completed。
  if (normalized.status === 'interrupted' || normalized.status === 'failed') {
    const derivedStatus = derivePlanStatus(normalized.status, plan.tasks);
    if (derivedStatus === TERMINAL_OK) {
      normalized.status = derivedStatus;
    }
  }
  const runner = normalizeRunnerState(plan.runner, plan.planId);
  const runTrace = normalizeRunTrace(plan.runTrace, { goalPlanId: plan.planId });
  const timing = normalizeGoalTiming(plan.timing);
  const withTiming = timing ? { ...normalized, timing } : normalized;
  const withRunTrace = runTrace.events.length > 0
    || runTrace.activeNodeId
    || runTrace.lastCheckpointNodeId
    ? { ...withTiming, runTrace }
    : withTiming;
  return runner ? { ...withRunTrace, runner } : withRunTrace;
}

function withRunTraceEvent(plan, event = {}) {
  if (!plan?.planId) return plan;
  const current = normalizeRunTrace(plan.runTrace, { goalPlanId: plan.planId });
  const normalizedEvent = normalizeRunEvent({
    ...event,
    goalPlanId: plan.planId,
    createdAt: event.createdAt || plan.updatedAt || new Date().toISOString(),
  }, { goalPlanId: plan.planId });
  if (!normalizedEvent) {
    return current.events.length > 0 || current.activeNodeId || current.lastCheckpointNodeId
      ? { ...plan, runTrace: current }
      : plan;
  }
  const nextTrace = {
    ...current,
    events: [...current.events, normalizedEvent],
  };
  const activeNodeId = normalizeOptionalString(event.activeNodeId) || normalizedEvent.nodeId;
  if (activeNodeId) nextTrace.activeNodeId = activeNodeId;
  if (normalizedEvent.type === 'checkpoint_created' && activeNodeId) {
    nextTrace.lastCheckpointNodeId = activeNodeId;
  }
  return { ...plan, runTrace: nextTrace };
}

function isActivePlan(plan) {
  return ACTIVE_PLAN_STATUSES.has(plan?.status);
}

function isInactivePlan(plan) {
  return plan?.status === 'cancelled';
}

/**
 * 用户回复可以消费 request_user_input 的计划态。
 * accepted + waiting_user 会出现在 intake 流错误残留、再被 goal_create_plan
 * 升成 accepted_goal 之后；只认 executing 会让「继续」永远吃不到回复。
 */
export function canConsumeRequestedUserInput(plan) {
  if (!plan) return false;
  if (plan.status !== 'executing' && plan.status !== 'accepted') return false;
  return ['waiting_user', 'blocked'].includes(plan.runner?.status)
    && plan.runner?.blockedReason === 'requested_user_input';
}

/**
 * intake → accepted_goal 升级时清掉流错误 / 收敛残留的「等用户」。
 * 真执行中的 request_user_input 不会走这条升级缝，不能在这里清。
 */
function runnerPatchForAcceptedGoalUpgrade(runner) {
  if (!runner || typeof runner !== 'object') return undefined;
  const hasInterruption = runner.interruption != null;
  const leftoverUserWait = runner.status === 'waiting_user'
    && runner.blockedReason === 'requested_user_input';
  if (!hasInterruption && !leftoverUserWait) return undefined;
  const next = {
    ...runner,
    interruption: null,
  };
  if (leftoverUserWait) {
    next.status = 'idle';
    next.intent = 'execute';
    next.phase = 'orient';
    next.blockedReason = undefined;
  }
  return next;
}

export function createGoalPlanStore({
  storeDir = pathOf('goalPlans'),
  onChange,
  readWorkspaceHead,
} = {}) {
  const indexFile = path.join(storeDir, 'index.jsonl');
  const evidenceIndexFile = path.join(storeDir, 'evidence-index.jsonl');
  const changeFile = path.join(storeDir, '.changes.jsonl');
  const evidenceRecordCache = new Map();
  const missingEvidenceRefCache = new Set();
  /** listPlans 归一化结果缓存：index mtime+size 未变时复用，避免反复 normalize×N。 */
  let listPlansCache = null; // { mtimeMs, size, plans }
  function invalidateListPlansCache() {
    listPlansCache = null;
  }
  function writeIndex(items) {
    writeJsonl(indexFile, items);
    invalidateListPlansCache();
  }
  // onChange 可变引用：Desktop 在构造时注入；TUI 需在建好 store 之后再挂
  // auto-start 闸门（见 goal-runner-adapter），故暴露 setOnChange 修改同一引用。
  let onChangeCallback = typeof onChange === 'function' ? onChange : null;
  function setOnChange(next) {
    onChangeCallback = typeof next === 'function' ? next : null;
  }

  // 变更通知 Seam：任何写操作（create/revise/approve/setStatus/recordTaskEvidence/delete）
  // 完成后触发 onChange，使 main 进程可向 renderer 广播 'goalPlans:changed'。
  // 收口于此，AI 工具路径（local-goal-provider）与 IPC 路径共享同一通知，
  // 无需在每个调用点重复挂广播。回调异常被吞掉，绝不影响写盘结果。
  //
  // payload 契约（向后兼容扩展）：
  // - reason: 写路径标签（persist/delete/...）
  // - planId / conversationId: 供 renderer 做会话域过滤
  // - changeKind: 变更分级（persist | delete | runner-progress | runner-state）
  // - runner: runner-progress 时附带最新 runner，便于 UI 本地 patch
  function createChangePayload(reason, planId, options = {}) {
    const conversationId =
      options.conversationId !== undefined
        ? options.conversationId ?? null
        : null;
    return {
      reason,
      planId: planId ?? null,
      conversationId,
      changeKind: options.changeKind ?? reason ?? 'persist',
      ...(options.runner ? { runner: options.runner } : {}),
    };
  }

  function publishPersistedChange(reason, planId, options = {}) {
    const payload = createChangePayload(reason, planId, options);
    try {
      writeGoalChangeEvent(storeDir, payload);
    } catch (err) {
      // 外部同步失败不回滚已完成的计划写盘，但必须保留可诊断信号。
      console.warn('[goal-plan-store] change event write failed:', err);
    }
    if (options.notifyLocal === false || typeof onChangeCallback !== 'function') return;
    try {
      onChangeCallback(payload);
    } catch (err) {
      // 广播失败不影响写盘结果，但显式打印以便排查（不要静默吞）。
      console.warn('[goal-plan-store] onChange broadcast failed:', err);
    }
  }

  function notifyChanged(reason, planId, options = {}) {
    if (typeof onChangeCallback !== 'function') return;
    try {
      onChangeCallback(createChangePayload(reason, planId, options));
    } catch (err) {
      // 广播失败不影响写盘结果，但显式打印以便排查（不要静默吞）。
      console.warn('[goal-plan-store] onChange broadcast failed:', err);
    }
  }

  function subscribeChanges(listener) {
    if (typeof listener !== 'function') return () => {};
    mkdirSync(storeDir, { recursive: true });
    if (!existsSync(changeFile)) writeFileSync(changeFile, '', 'utf8');

    const currentSize = () => {
      const fd = openSync(changeFile, 'r');
      try {
        return fstatSync(fd).size;
      } finally {
        closeSync(fd);
      }
    };

    // Start at EOF: historical rows are already represented by persisted plans. Subsequent drains
    // read only appended bytes instead of repeatedly loading the entire, potentially large journal.
    let offset = currentSize();
    let pending = Buffer.alloc(0);
    let draining = false;
    let drainAgain = false;
    const drain = () => {
      if (draining) {
        drainAgain = true;
        return;
      }
      draining = true;
      try {
        do {
          drainAgain = false;
          let fd;
          try {
            fd = openSync(changeFile, 'r');
            const size = fstatSync(fd).size;
            if (size < offset) {
              // The journal was truncated in place. Drop any incomplete row from the old file.
              offset = 0;
              pending = Buffer.alloc(0);
            }
            let remaining = size - offset;
            while (remaining > 0) {
              const chunk = Buffer.allocUnsafe(Math.min(remaining, 64 * 1024));
              const bytesRead = readSync(fd, chunk, 0, chunk.length, offset);
              if (bytesRead <= 0) break;
              offset += bytesRead;
              remaining -= bytesRead;
              pending = pending.length > 0
                ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
                : chunk.subarray(0, bytesRead);

              let newlineIndex;
              while ((newlineIndex = pending.indexOf(0x0a)) >= 0) {
                const line = pending.subarray(0, newlineIndex).toString('utf8');
                pending = pending.subarray(newlineIndex + 1);
                if (!line.trim()) continue;
                try {
                  listener(JSON.parse(line));
                } catch {
                  // Ignore malformed rows while preserving later valid events.
                }
              }
            }
          } catch {
            // A concurrent writer may be between filesystem observations; the next event will retry.
          } finally {
            if (fd !== undefined) closeSync(fd);
          }
        } while (drainAgain);
      } finally {
        draining = false;
      }
    };
    const watcher = watch(changeFile, { persistent: false }, drain);
    // Close the size-snapshot → watch race without rereading historical journal bytes.
    drain();
    return () => watcher.close();
  }

  /** Runner 高频进度字段：仅计数/阶段跳动时走 runner-progress，避免无关会话全量 list。 */
  const RUNNER_PROGRESS_KEYS = new Set([
    'turnCount',
    'roundCount',
    'toolCallCount',
    'explorerCount',
    'updatedAt',
    'phase',
    'currentTaskId',
    'lastTickAt',
  ]);

  function classifyRunnerChangeKind(patch = {}) {
    const keys = Object.keys(patch).filter((key) => patch[key] !== undefined);
    if (keys.length === 0) return 'runner-state';
    return keys.every((key) => RUNNER_PROGRESS_KEYS.has(key))
      ? 'runner-progress'
      : 'runner-state';
  }

  // runner-progress 内存叠加 + 写盘节流：保证同 tick 内 getPlan 读到最新计数，
  // 同时把磁盘写入合并到 1s 窗口，降低 CLI 后台跑时跨进程 .changes.jsonl 放大。
  const runnerProgressOverlay = new Map();
  const runnerProgressTimers = new Map();
  // soft progress：同进程广播 100ms；跨进程写盘 1s。硬状态仍即时。
  const runnerProgressNotifyTimers = new Map();
  const RUNNER_PROGRESS_PERSIST_MS = 1000;
  const RUNNER_PROGRESS_NOTIFY_MS = 100;

  function clearRunnerProgressState(planId) {
    if (planId) {
      runnerProgressOverlay.delete(planId);
      const timer = runnerProgressTimers.get(planId);
      if (timer) {
        clearTimeout(timer);
        runnerProgressTimers.delete(planId);
      }
      const notifyTimer = runnerProgressNotifyTimers.get(planId);
      if (notifyTimer) {
        clearTimeout(notifyTimer);
        runnerProgressNotifyTimers.delete(planId);
      }
      return;
    }
    for (const timer of runnerProgressTimers.values()) clearTimeout(timer);
    runnerProgressTimers.clear();
    for (const timer of runnerProgressNotifyTimers.values()) clearTimeout(timer);
    runnerProgressNotifyTimers.clear();
    runnerProgressOverlay.clear();
  }

  function flushRunnerProgressPersist(planId, { notify = false } = {}) {
    const timer = runnerProgressTimers.get(planId);
    if (timer) {
      clearTimeout(timer);
      runnerProgressTimers.delete(planId);
    }
    const overlay = runnerProgressOverlay.get(planId);
    if (!overlay) return null;
    const normalized = normalizePlan(overlay);
    const next = {
      ...normalized,
      status: derivePlanStatus(normalized.status, normalized.tasks),
      progress: aggregateProgress(normalized.tasks),
    };
    writeJsonAtomic(planFile(next.planId), next);
    syncIndex(next);
    // 落盘后保留 overlay 内容一致；完整 persist 路径会清 overlay。
    runnerProgressOverlay.set(planId, next);
    publishPersistedChange('persist', next.planId, {
      conversationId: next.conversationId ?? null,
      changeKind: 'runner-progress',
      runner: next.runner ?? null,
      notifyLocal: notify,
    });
    return next;
  }

  function scheduleRunnerProgressPersist(planId) {
    if (runnerProgressTimers.has(planId)) return;
    const timer = setTimeout(() => {
      runnerProgressTimers.delete(planId);
      flushRunnerProgressPersist(planId, { notify: false });
    }, RUNNER_PROGRESS_PERSIST_MS);
    runnerProgressTimers.set(planId, timer);
  }

  /** soft progress 广播合并：同一 plan 100ms 窗口只推最新 runner 快照。 */
  function scheduleRunnerProgressNotify(planId, conversationId) {
    if (runnerProgressNotifyTimers.has(planId)) return;
    const timer = setTimeout(() => {
      runnerProgressNotifyTimers.delete(planId);
      const plan = runnerProgressOverlay.get(planId) || plans.get(planId);
      if (!plan) return;
      notifyChanged('persist', planId, {
        conversationId: conversationId ?? plan.conversationId ?? null,
        changeKind: 'runner-progress',
        runner: plan.runner ?? null,
      });
    }, RUNNER_PROGRESS_NOTIFY_MS);
    runnerProgressNotifyTimers.set(planId, timer);
  }

  function planFile(id) {
    return path.join(storeDir, `${id}.json`);
  }

  function readIndex() {
    // §12 性能治理：listPlans 热路径走 stat 缓存（mtimeMs+size 未变时复用解析结果）。
    return readJsonlCached(indexFile);
  }

  function readEvidenceIndex() {
    return readJsonl(evidenceIndexFile)
      .map(normalizeEvidenceIndexRecord)
      .filter(Boolean);
  }

  function findEvidenceIndexRecords(refs) {
    const normalizedRefs = normalizeEvidenceRefList(refs);
    const missing = normalizedRefs.filter(
      (ref) => !evidenceRecordCache.has(ref) && !missingEvidenceRefCache.has(ref),
    );
    if (missing.length > 0) {
      const found = readEvidenceRecordsFromTail(evidenceIndexFile, missing);
      const foundRefs = new Set();
      for (const record of found) {
        foundRefs.add(record.evidenceRef);
        evidenceRecordCache.set(record.evidenceRef, record);
      }
      for (const ref of missing) {
        if (!foundRefs.has(ref)) missingEvidenceRefCache.add(ref);
      }
    }
    return normalizedRefs.map((ref) => evidenceRecordCache.get(ref)).filter(Boolean);
  }

  function inferEvidencePlanId(planId, conversationId) {
    const normalizedPlanId = normalizeOptionalString(planId);
    if (normalizedPlanId) return normalizedPlanId;
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (!normalizedConversationId) return null;
    return getActivePlanByConversation(normalizedConversationId)?.planId ?? null;
  }

  function recordEvidenceRefs(entry = {}) {
    const refs = normalizeEvidenceRefList(entry.evidenceRefs ?? entry.evidenceRef);
    if (refs.length === 0) return [];
    const conversationId = normalizeConversationId(entry.conversationId);
    const planId = inferEvidencePlanId(entry.planId, conversationId);
    const artifactRefs = normalizeEvidenceRefList(entry.artifactRefs);
    const createdAt = normalizeOptionalString(entry.createdAt) || new Date().toISOString();
    const base = { createdAt };
    if (planId) base.planId = planId;
    if (conversationId) base.conversationId = conversationId;
    for (const field of ['streamId', 'toolCallId', 'capabilityId', 'toolName']) {
      const normalized = normalizeOptionalString(entry[field]);
      if (normalized) base[field] = normalized;
    }
    if (artifactRefs.length > 0) base.artifactRefs = artifactRefs;
    if (Array.isArray(entry.userArtifacts) && entry.userArtifacts.length > 0) {
      base.userArtifacts = entry.userArtifacts;
    }
    const records = refs
      .map((evidenceRef) => normalizeEvidenceIndexRecord({ ...base, evidenceRef }))
      .filter(Boolean);
    const mergedRecords = [];
    for (const record of records) {
      const merged = mergeEvidenceIndexRecords(evidenceRecordCache.get(record.evidenceRef), record);
      appendJsonl(evidenceIndexFile, merged);
      missingEvidenceRefCache.delete(record.evidenceRef);
      evidenceRecordCache.set(record.evidenceRef, merged);
      mergedRecords.push(merged);
    }
    return mergedRecords;
  }

  function evidenceRecordMatchesPlan(record, plan) {
    if (!record || !plan) return false;
    if (record.planId && record.planId === plan.planId) return true;
    const planConversationId = normalizeConversationId(plan.conversationId);
    return Boolean(
      planConversationId
        && normalizeConversationId(record.conversationId) === planConversationId,
    );
  }

  function indexedEvidenceRefsForPlan(plan, refs) {
    const wanted = new Set(normalizeEvidenceRefList(refs));
    if (!plan || wanted.size === 0) return new Set();
    const found = new Set();
    for (const record of readEvidenceIndex()) {
      if (!wanted.has(record.evidenceRef)) continue;
      if (evidenceRecordMatchesPlan(record, plan)) found.add(record.evidenceRef);
    }
    return found;
  }

  function assertAnyEvidenceRefIndexed(plan, refs, context) {
    const normalizedRefs = normalizeEvidenceRefList(refs);
    if (normalizedRefs.length === 0) return;
    if (indexedEvidenceRefsForPlan(plan, normalizedRefs).size > 0) return;
    throw new Error(
      `[goal-plan-store] ${context} evidenceRefs are not registered in EvidenceIndex: ${normalizedRefs.join(', ')}`,
    );
  }

  function assertEvidenceRefIndexed(plan, ref, context) {
    const normalizedRef = normalizeOptionalString(ref);
    if (!normalizedRef) return;
    if (indexedEvidenceRefsForPlan(plan, [normalizedRef]).size > 0) return;
    throw new Error(
      `[goal-plan-store] ${context} evidenceRef is not registered in EvidenceIndex: ${normalizedRef}`,
    );
  }

  function toMeta(plan) {
    return {
      planId: plan.planId,
      title: plan.title,
      status: plan.status,
      workflowKind: plan.workflowKind,
      conversationId: plan.conversationId ?? null,
      threadId: plan.threadId ?? null,
      // 工作区归属随轻量索引持久化，列表消费者可先筛候选再读取详情。
      originWorkspacePath: plan.originWorkspacePath ?? null,
      targetWorkspacePath: plan.targetWorkspacePath ?? null,
      targetRepoId: plan.targetRepoId ?? null,
      targetBranch: plan.targetBranch ?? null,
      targetBranchSource: plan.targetBranchSource ?? null,
      version: plan.version,
      percent: plan.progress?.percent ?? 0,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      // TaskOverview 可在 hydrate 前排除已验收/祖父化 completed。
      resultAcceptance: plan.resultAcceptance ?? null,
      resultAcceptedAt: plan.resultAcceptedAt ?? null,
      resultAcceptedBy: plan.resultAcceptedBy ?? null,
      // 候选筛要在 hydrate 前看见真实交回态，避免交回中的已验收被提前丢掉。
      deliveryHandoff: plan.deliveryHandoff ?? null,
    };
  }

  function syncIndex(plan) {
    const index = readIndex().filter((m) => m.planId !== plan.planId);
    index.push(toMeta(plan));
    writeIndex( index);
  }

  function persist(plan, options = {}) {
    // progress 始终由子任务聚合派生，写入前强制重算覆盖（不可手填）。
    // timing 在 status 实际迁移时推进；同状态写入仅规范化，不重复开关 segment。
    // 调用方通常传入 { ...plan, status: next }，所以 prevStatus 必须取磁盘旧值
    // （或 options 显式覆盖），不能用入参上的新 status。
    const existing = plan?.planId ? (() => {
      try {
        const file = planFile(plan.planId);
        if (!existsSync(file)) return null;
        return normalizePlan(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        return null;
      }
    })() : null;
    const prevStatus = options.prevStatus ?? existing?.status;
    const prevTiming = options.prevTiming ?? existing?.timing;
    const shouldAttachBinding = Boolean(
      plan?.targetWorkspacePath
      && !existing?.deliveryBinding
      && (
        !existing
        || existing.targetWorkspacePath !== plan.targetWorkspacePath
        || (existing.activation?.kind === 'intake' && plan.activation?.kind !== 'intake')
      ),
    );
    const normalized = normalizePlan(
      shouldAttachBinding
        ? attachWorkspaceHeadBinding(plan, { readWorkspaceHead })
        : plan,
    );
    // 已停止且尚未消费的执行中断是独立于叶子任务的可恢复挂起事实（ADR 73），
    // 普通 persist 不能把 interrupted 重新派生为 completed；仅 resumeRunner 能
    // 原子消费该事实并恢复执行。可恢复中断在重试预算内仍由 running Runner 持有
    // 行动权，只记录失败尝试，不能因为 interruption Evidence 的存在就把整个计划
    // 降级为失败终态；真实叶子失败仍由 derivePlanStatus 派生为 failed。
    const derivedStatus = options.preserveStatus
      ? normalized.status
      : derivePlanStatus(normalized.status, normalized.tasks);
    const hasUnconsumedInterruption = Boolean(
      normalized.runner?.interruption &&
      !(normalized.runner.interruption.recoverable === true && normalized.runner.status === 'running'),
    );
    // 未消费中断只拦住「还没做完」的计划。叶子已全部成功时，不能再用过期
    // interruption 把 completed 钉回 interrupted。
    const nextStatus = hasUnconsumedInterruption && derivedStatus !== TERMINAL_OK
      ? 'interrupted'
      : derivedStatus;
    const nowIso = normalized.updatedAt || new Date().toISOString();
    const planTiming = applyGoalTimingTransition(
      prevTiming,
      prevStatus,
      nextStatus,
      nowIso,
    );
    const timing = reconcileGoalTimingWithRunner(
      planTiming,
      nextStatus,
      normalized.runner?.status,
      nowIso,
    );
    const next = {
      ...normalized,
      // 默认按叶子事实派生；preserveStatus 用于显式 setPlanStatus（如 stream_error → failed），
      // 避免瞬时失败态在同一次写入中被立刻恢复。后续 recordTaskEvidence 会重新派生。
      status: nextStatus,
      progress: aggregateProgress(normalized.tasks),
      ...(timing ? { timing } : {}),
    };
    // 终态 / 非执行态时若 timing 已清空 open segment 且历史无 timing，不强制写空对象
    if (!timing && Object.prototype.hasOwnProperty.call(next, 'timing')) {
      delete next.timing;
    }
    // 完整写盘优先：清掉 runner-progress 节流状态，避免旧计数回写覆盖。
    clearRunnerProgressState(next.planId);
    writeJsonAtomic(planFile(next.planId), next);
    syncIndex(next);
    publishPersistedChange('persist', next.planId, {
      conversationId: next.conversationId ?? null,
      changeKind: options.changeKind ?? 'persist',
      ...(options.runner ? { runner: options.runner } : {}),
    });
    return next;
  }

  function activeMeta(meta) {
    return !isInactivePlan(meta);
  }

  function listPlans() {
    let stat = null;
    try {
      stat = statSync(indexFile);
    } catch {
      listPlansCache = null;
      return [];
    }
    if (
      listPlansCache &&
      listPlansCache.mtimeMs === stat.mtimeMs &&
      listPlansCache.size === stat.size
    ) {
      return listPlansCache.plans.slice();
    }
    const plans = readIndex()
      .map(normalizePlan)
      .filter((m) => m && activeMeta(m))
      .sort((a, b) =>
        String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
      );
    listPlansCache = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      plans,
    };
    return plans.slice();
  }

  function listPlansByConversation(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId === null) return [];
    return listPlans().filter((m) => normalizeConversationId(m.conversationId) === normalizedConversationId);
  }

  /**
   * 侧栏徽标聚合：只扫 index meta，不 hydrate 全量 plan JSON。
   * 返回 { [conversationId]: number }，仅包含 awaiting_approval > 0 的会话。
   */
  function countAwaitingApprovalsByConversation() {
    const counts = Object.create(null);
    for (const meta of readIndex()) {
      const m = normalizePlan(meta);
      if (!m || isInactivePlan(m)) continue;
      if (m.status !== 'awaiting_approval') continue;
      const conversationId = normalizeConversationId(m.conversationId);
      if (!conversationId) continue;
      counts[conversationId] = (counts[conversationId] || 0) + 1;
    }
    return counts;
  }

  function hydratePlanMeta(meta) {
    if (!meta?.planId) return null;
    const plan = getPlan(meta.planId);
    if (!plan || isInactivePlan(plan)) return null;
    if (plan.progress) return plan;
    return { ...plan, progress: aggregateProgress(plan.tasks) };
  }

  function selectPlanMetas(metas, options = {}) {
    const candidateFilter = typeof options?.candidateFilter === 'function'
      ? options.candidateFilter
      : null;
    const limit = Number.isFinite(options?.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : 0;
    const selected = [];
    for (const meta of metas) {
      if (candidateFilter) {
        try {
          if (candidateFilter(meta) !== true) continue;
        } catch {
          // 筛选器异常时宁可多 hydrate，也不能把工作台任务漏掉。
        }
      }
      selected.push(meta);
    }
    return limit > 0 ? selected.slice(0, limit) : selected;
  }

  function listPlanDetails(options = {}) {
    return selectPlanMetas(listPlans(), options).map(hydratePlanMeta).filter(Boolean);
  }

  /**
   * 仅 hydrate 与指定工作区直接关联的计划。
   *
   * 新索引行可直接按 origin/targetWorkspacePath 筛选；旧索引行没有工作区字段时，
   * 只回退读取这些 legacy 详情，避免升级后漏掉历史计划。
   */
  function listPlanDetailsByWorkspace(workspacePath, options = {}) {
    const normalizePath = (value) => typeof value === 'string'
      ? value.trim().replace(/[/\\]+$/, '').toLowerCase()
      : '';
    const wanted = normalizePath(workspacePath);
    if (!wanted) return listPlanDetails(options);
    const candidateFilter = typeof options?.candidateFilter === 'function'
      ? options.candidateFilter
      : null;
    const limit = Number.isFinite(options?.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : 0;

    const index = readIndex();
    let indexChanged = false;
    const indexedMatches = [];
    const details = [];
    const nextIndex = index.map((rawMeta) => {
      const meta = normalizePlan(rawMeta);
      if (!meta || !activeMeta(meta)) return rawMeta;

      const hasWorkspaceIndex = Object.hasOwn(rawMeta, 'originWorkspacePath')
        || Object.hasOwn(rawMeta, 'targetWorkspacePath');
      const indexedWorkspacePath = normalizePath(
        meta.originWorkspacePath ?? meta.targetWorkspacePath,
      );
      if (hasWorkspaceIndex && indexedWorkspacePath !== wanted) return rawMeta;
      if (candidateFilter) {
        try {
          if (candidateFilter(meta) !== true) return rawMeta;
        } catch {
          // 筛选器异常时继续，避免漏掉工作区任务。
        }
      }

      if (hasWorkspaceIndex) {
        indexedMatches.push(meta);
        return rawMeta;
      }

      // 旧索引没有工作区字段时才回退读详情，用来补齐并判断归属。
      const plan = hydratePlanMeta(meta);
      if (!plan) return rawMeta;
      const planWorkspacePath = normalizePath(
        plan.originWorkspacePath ?? plan.targetWorkspacePath,
      );
      if (planWorkspacePath === wanted) details.push(plan);
      indexChanged = true;
      return {
        ...rawMeta,
        originWorkspacePath: plan.originWorkspacePath ?? null,
        targetWorkspacePath: plan.targetWorkspacePath ?? null,
      };
    });

    indexedMatches.sort((a, b) =>
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
    );
    const remaining = limit > 0 ? Math.max(0, limit - details.length) : indexedMatches.length;
    const selectedIndexed = limit > 0 ? indexedMatches.slice(0, remaining) : indexedMatches;
    for (const meta of selectedIndexed) {
      const plan = hydratePlanMeta(meta);
      if (!plan) continue;
      const planWorkspacePath = normalizePath(
        plan.originWorkspacePath ?? plan.targetWorkspacePath,
      );
      if (planWorkspacePath === wanted) details.push(plan);
    }

    // 旧索引只在首次按工作区读取时补齐一次，后续切换即可直接跳过无关详情文件。
    if (indexChanged) writeIndex( nextIndex);
    return details;
  }

  function listPlanDetailsByConversation(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId === null) return [];
    return listPlansByConversation(normalizedConversationId).map(hydratePlanMeta).filter(Boolean);
  }

  function getActivePlanByConversation(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId === null) return null;
    const activePlans = listPlanDetailsByConversation(normalizedConversationId)
      .filter(isActivePlan)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return activePlans[0] ?? null;
  }

  function isUnacceptedCompletedPlan(plan) {
    return plan?.status === 'completed'
      && !(
        plan.resultAcceptance
        && typeof plan.resultAcceptance.acceptedAt === 'string'
        && plan.resultAcceptance.acceptedAt.trim()
      );
  }

  /**
   * 同会话最近一条未验收 completed 计划。新开 Goal 时它应作为旧计划留下，
   * 不能被自动取消。
   */
  function getUnacceptedCompletedPlanByConversation(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId === null) return null;
    const plans = listPlanDetailsByConversation(normalizedConversationId)
      .filter(isUnacceptedCompletedPlan)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return plans[0] ?? null;
  }

  function getPlan(planId) {
    const overlay = runnerProgressOverlay.get(planId);
    if (overlay) return normalizePlan(overlay);
    return normalizePlan(readJson(planFile(planId)));
  }

  /**
   * 同会话「单活跃计划」约束：新建计划落库前，把同一会话下其它仍处于活跃态
   * （drafting / awaiting_approval / approved / executing / paused）的旧计划做收尾或作废，
   * 从源头杜绝「僵尸计划」累积——否则用户中途改方案另起新计划时，旧计划永远停在
   * awaiting_approval 或 executing，让浮条长期显示「待批准 / 执行中」、锁定展开且计划数虚高。
   *
   * 收尾策略（按旧计划当前状态分流）：
   * - awaiting_approval：尚未批准的草稿，直接作废为 cancelled（既有行为，保持不变）。
   * - 其它活跃态（drafting / approved / executing / paused）：
   *   · 若旧计划存在叶子且全部叶子均为终态（completed/failed），按 derivePlanStatus
   *     如实收尾为 completed/failed（不谎报、保留真实完成度）；
   *   · 否则仍有未完成叶子，作废为 cancelled，并在审计原因里标注 superseded。
   *
   * 设计约束：
   * - 仅在 conversationId 非空时生效（未关联会话的计划互不影响，绝不按 null===null 误伤）。
   * - exceptPlanId 排除新计划自身。
   * - 走 persist 正规写盘 + onChange 广播（不旁路），并向 revisionHistory 追加一条
   *   supersede 审计，保留可追溯事实。
   * - 活跃态计划照旧收尾/作废。
   * - 已完成（含未验收）计划是同会话下的既有 Goal：新开 Goal 时必须留下，
   *   不能标成 cancelled 从面板上抹掉。
   *
   * @param {string|null|undefined} conversationId
   * @param {string|null|undefined} exceptPlanId
   * @param {string} [reason]
   * @returns {string[]} 被收尾或作废的 planId 列表
   */
  function supersedeAwaitingDrafts(conversationId, exceptPlanId, reason) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId === null) return [];
    const superseded = [];
    for (const meta of listPlansByConversation(normalizedConversationId)) {
      if (meta.planId === exceptPlanId) continue;
      const plan = getPlan(meta.planId);
      if (!plan) continue;

      // 已完成（含未验收）计划是同会话下的既有 Goal，新开 Goal 时必须留下。
      if (isUnacceptedCompletedPlan(plan) || plan.status === 'completed') continue;
      // 仅处理仍在飞的活跃态；failed / cancelled 不触碰。
      if (!isActivePlan(plan)) continue;

      let nextStatus;
      let reasonText;
      if (plan.status === 'awaiting_approval') {
        // 未批准草稿：保持既有行为，直接作废。
        nextStatus = 'cancelled';
        reasonText = reason || 'superseded by a newer plan in the same conversation';
      } else {
        // 其它活跃态：能 derive 到终态的如实收尾，否则作废。
        // 以 'executing' 为基准探测叶子终态（derivePlanStatus 仅在 executing 分支做收尾派生）。
        const derived = derivePlanStatus('executing', plan.tasks);
        if (derived === TERMINAL_OK || derived === TERMINAL_FAIL) {
          nextStatus = derived;
          reasonText =
            'auto-finalized on supersede: all subtasks reached terminal state';
        } else {
          nextStatus = 'cancelled';
          reasonText =
            reason || 'superseded by a newer active plan in the same conversation';
        }
      }

      const nextVersion = (plan.version || 1) + 1;
      const nextPlan = {
        ...plan,
        status: nextStatus,
        version: nextVersion,
        revisionHistory: [
          ...(plan.revisionHistory || []),
          {
            version: nextVersion,
            reason: reasonText,
            changedAt: new Date().toISOString(),
            changedBy: 'system:supersede',
          },
        ],
        updatedAt: new Date().toISOString(),
      };
      persist(nextPlan);
      superseded.push(meta.planId);
    }
    return superseded;
  }

  /**
   * 创建草稿计划（status='drafting'）。progress 由 tasks 聚合派生。
   *
   * 同会话单活跃计划：落库前先对同会话其它仍处于活跃态（drafting / awaiting_approval /
   * approved / executing / paused）的旧计划做收尾或作废（见 supersedeAwaitingDrafts）——
   * 全叶子终态的如实收尾为 completed/failed，否则作废为 cancelled，杜绝「僵尸 executing 计划」累积。
   */

  function sanitizePlanTitle(rawTitle, goalText) {
    const raw = typeof rawTitle === 'string' ? rawTitle.replace(/\s+/g, ' ').trim() : '';
    const goal = typeof goalText === 'string' ? goalText.replace(/\s+/g, ' ').trim() : '';
    const isAck = (value) => /^(好|好的|行|可以|认可|ok|okay|yes|yep|lgtm)([,，、\s].*)?$|^(好|好的)?[,，、\s]*就这么做[.!！。…]*$|^(就这么做)[.!！。…]*$/i.test(value || '');
    const isCmd = (value) => /^[>$]\s/.test(value || '') || (/\b(tsc|npm|pnpm|yarn|node)\b/i.test(value || '') && (value || '').includes('/'));
    // 用户首句/长 goal 常被误塞进 title。标题应是短意图名，不能回退成 goal 截断。
    const looksLikeRawUtterance = (value) => {
      if (!value) return false;
      if (value.length > 40) return true;
      if (/[?？]$/.test(value) || /(?:吧|吗|呢)$/.test(value)) return true;
      // 多子句口语长句（逗号/顿号较多）不像「动词+对象」短标题。
      if (value.length > 18 && (value.match(/[，,、；;]/g) || []).length >= 1 && /[。.!！]/.test(value) === false) {
        return /(?:不应该|能不能|可不可以|怎么|如何|一下|这个|那种)/.test(value);
      }
      return false;
    };
    const isGoalEcho = (value) => {
      if (!value || !goal) return false;
      if (value === goal) return true;
      // 旧逻辑会把 goal 截成 `${goal.slice(0, 24)}…`；只把这类截断回声当坏标题，
      // 不要把「恰好是 goal 前缀」的合法短意图名误杀。
      if (!(value.endsWith('…') || value.endsWith('...'))) return false;
      const stripped = value.replace(/[.…]+$/g, '').trim();
      return Boolean(stripped) && goal.startsWith(stripped);
    };
    let title = raw;
    if (
      !title
      || isAck(title)
      || isCmd(title)
      || looksLikeRawUtterance(title)
      || isGoalEcho(title)
    ) {
      // 故意不用 goal 截断兜底：否则浮动条/任务卡会继续显示用户原话。
      title = '未命名任务';
    }
    return title;
  }

  function createPlan(draft = {}, { changeKind = 'persist' } = {}) {
    const now = new Date().toISOString();
    const tasks = Array.isArray(draft.tasks) ? draft.tasks : [];
    const workflowKind = normalizeWorkflowKind(draft.workflowKind);
    const status = draft.status || (workflowKind === 'goal_self_driven' ? 'accepted' : 'drafting');
    const planId = draft.planId || randomUUID();
    const requestedParentPlanId = typeof draft.parentPlanId === 'string' && draft.parentPlanId.trim()
      ? draft.parentPlanId.trim()
      : undefined;
    const requestedSourceTaskId = typeof draft.sourceTaskId === 'string' && draft.sourceTaskId.trim()
      ? draft.sourceTaskId.trim()
      : undefined;
    if (requestedParentPlanId && requestedParentPlanId === planId) {
      throw new Error('parentPlanId cannot be its own parent');
    }
    const parentPlan = requestedParentPlanId ? getPlan(requestedParentPlanId) : null;
    const sourceTask = parentPlan && requestedSourceTaskId
      ? parentPlan.tasks?.find((task) => task.taskId === requestedSourceTaskId)
      : null;
    if (requestedParentPlanId && !parentPlan) {
      throw new Error(`Parent goal not found: ${requestedParentPlanId}`);
    }
    if (requestedParentPlanId && !requestedSourceTaskId) {
      throw new Error('sourceTaskId is required when parentPlanId is provided');
    }
    if (requestedSourceTaskId && !requestedParentPlanId) {
      throw new Error('parentPlanId is required when sourceTaskId is provided');
    }
    if (requestedSourceTaskId && !sourceTask) {
      throw new Error(`Source task not found in parent goal: ${requestedSourceTaskId}`);
    }
    const plan = {
      planId,
      conversationId: normalizeConversationId(draft.conversationId) ?? undefined,
      threadId: draft.threadId,
      agentId: draft.agentId,
      originWorkspacePath: normalizeWorkspacePath(draft.originWorkspacePath) ?? undefined,
      targetWorkspacePath: normalizeWorkspacePath(draft.targetWorkspacePath) ?? undefined,
      targetRepoId: normalizeOptionalName(draft.targetRepoId) ?? normalizeOptionalName(draft.deliveryBinding?.repoId),
      targetBranch: normalizeOptionalName(draft.targetBranch) ?? normalizeOptionalName(draft.deliveryBinding?.targetBranch),
      baseCommit: normalizeOptionalName(draft.baseCommit) ?? normalizeOptionalName(draft.deliveryBinding?.baseCommit),
      targetBranchSource: normalizeTargetBranchSource(draft.targetBranchSource)
        ?? normalizeTargetBranchSource(draft.deliveryBinding?.targetBranchSource),
      deliveryBinding: normalizeDeliveryBinding(draft.deliveryBinding, {
        targetWorkspacePath: draft.targetWorkspacePath,
        baseCommit: draft.baseCommit,
      }),
      parentPlanId: parentPlan?.planId,
      sourceTaskId: sourceTask?.taskId,
      rootPlanId: parentPlan ? (parentPlan.rootPlanId || parentPlan.planId) : undefined,
      relationType: parentPlan ? 'derived' : undefined,
      depth: parentPlan ? (Number.isInteger(parentPlan.depth) ? parentPlan.depth + 1 : 1) : undefined,
      title: sanitizePlanTitle(draft.title, draft.goal),
      goal: draft.goal || '',
      // 成功标准规范化为结构化 SuccessCriterion[]（字符串向后兼容归一为 manual）。
      successCriteria: normalizeSuccessCriteria(draft.successCriteria),
      // 验证结果：post-act 由 goal_update_task 回写，创建时默认空。
      criterionResults: normalizeCriterionResults(draft.criterionResults),
      // Manual DoD 的治理确认事实。它不是 plan approval，只服务完成前人工验收。
      manualConfirmations: normalizeManualConfirmations(draft.manualConfirmations),
      boundaries: draft.boundaries || { inScope: [], outOfScope: [] },
      exceptionPolicies: draft.exceptionPolicies || [],
      involvedFiles: draft.involvedFiles || [],
      tasks,
      workflowKind,
      activation: normalizeActivation(draft.activation, workflowKind, status),
      executionPolicy: normalizeExecutionPolicy(draft.executionPolicy, workflowKind),
      status,
      approval: draft.approval,
      progress: aggregateProgress(tasks),
      runTrace: draft.runTrace,
      version: 1,
      revisionHistory: [],
      evidenceRefs: draft.evidenceRefs || [],
      promptContextEpochId: draft.promptContextEpochId,
      createdAt: now,
      updatedAt: now,
      createdBy: draft.createdBy,
    };
    const isGoalIntake = workflowKind === 'goal_self_driven' && plan.activation?.kind === 'intake';
    const createEventType = isGoalIntake
      ? 'goal_intake_started'
      : workflowKind === 'goal_self_driven'
        ? 'goal_created'
        : 'plan_created';
    const createEventSummary = isGoalIntake
      ? '开始判断这是不是一个目标'
      : workflowKind === 'goal_self_driven'
        ? '目标已建立'
        : '计划已生成';
    // 单活跃计划：先收尾/作废同会话其它活跃态旧计划（排除自身），再落库新计划。
    supersedeAwaitingDrafts(plan.conversationId, plan.planId);
    const created = persist(withRunTraceEvent(plan, {
      type: createEventType,
      summary: createEventSummary,
      payload: {
        source: 'goal-plan-store:createPlan',
        summaryCode: createEventType,
        workflowKind,
        status,
        activationKind: plan.activation?.kind,
        taskCount: tasks.length,
      },
    }), { changeKind });
    if (parentPlan && sourceTask) {
      const now = new Date().toISOString();
      const linked = updateTaskInTree(parentPlan.tasks, sourceTask.taskId, (task) => ({
        ...task,
        executionMode: 'delegated',
        childPlanIds: [...new Set([...(task.childPlanIds || []), created.planId])],
      }));
      const relationPayload = {
        parentPlanId: parentPlan.planId,
        childPlanId: created.planId,
        sourceTaskId: sourceTask.taskId,
        rootPlanId: created.rootPlanId,
      };
      persist({ ...parentPlan, tasks: linked.tasks, updatedAt: now });
      appendRunEvent(parentPlan.planId, {
        type: 'child_goal_created',
        taskId: sourceTask.taskId,
        payload: relationPayload,
      });
      appendRunEvent(created.planId, {
        type: 'child_goal_created',
        taskId: sourceTask.taskId,
        payload: relationPayload,
      });
    }
    return created;
  }

  function createGoalContract(draft = {}) {
    const goal = typeof draft.goal === 'string' ? draft.goal : '';
    const tasks = Array.isArray(draft.tasks) && draft.tasks.length > 0
      ? draft.tasks
      : [makeDefaultGoalTask(goal)];
    const acceptedAt = typeof draft.activation?.acceptedAt === 'string' && draft.activation.acceptedAt.trim()
      ? draft.activation.acceptedAt.trim()
      : new Date().toISOString();
    return createPlan({
      ...draft,
      tasks,
      status: draft.status || 'accepted',
      workflowKind: 'goal_self_driven',
      activation: {
        kind: 'accepted_goal',
        sourceMessageId: draft.activation?.sourceMessageId,
        acceptedAt,
        acceptedBy: draft.activation?.acceptedBy || draft.createdBy || 'user',
      },
      executionPolicy: {
        ...DEFAULT_SELF_DRIVEN_POLICY,
        ...(draft.executionPolicy && typeof draft.executionPolicy === 'object'
          ? draft.executionPolicy
          : {}),
        autonomy: 'self_driven',
      },
      createdBy: draft.createdBy || 'user',
    }, { changeKind: 'goal-accepted' });
  }

  /**
   * 创建 intake 判别契约：工作流仍是自驱 goal（Runner 会驱动），但 activation.kind='intake'，
   * 表示尚未确认是否为一个真实目标。Runner 在 intake 阶段只做只读/问答/澄清，禁副作用。
   * 判定为纯问答由上层 deletePlan 静默移除；判定为明确目标则 promoteIntakeToGoal 升级。
   */
  function createIntakeContract(draft = {}) {
    const goal = typeof draft.goal === 'string' ? draft.goal : '';
    const tasks = Array.isArray(draft.tasks) && draft.tasks.length > 0
      ? draft.tasks
      : [makeDefaultGoalTask(goal)];
    return createPlan({
      ...draft,
      tasks,
      status: draft.status || 'executing',
      workflowKind: 'goal_self_driven',
      activation: {
        kind: 'intake',
        sourceMessageId: draft.activation?.sourceMessageId,
      },
      executionPolicy: {
        ...DEFAULT_SELF_DRIVEN_POLICY,
        ...(draft.executionPolicy && typeof draft.executionPolicy === 'object'
          ? draft.executionPolicy
          : {}),
        autonomy: 'self_driven',
      },
      createdBy: draft.createdBy || 'user',
    });
  }

  /**
   * 把一条 intake 契约升级为正式的 accepted_goal（判定为明确目标时调用）。
   * 允许传入判别后梳理出的结构化 goal/title/successCriteria/tasks/boundaries 覆盖原草稿。
   */
  function promoteIntakeToGoal(planId, patch = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const acceptedAt = new Date().toISOString();
    const upgradeRunner = runnerPatchForAcceptedGoalUpgrade(plan.runner);
    return revisePlan(planId, {
      ...patch,
      ...(!plan.targetWorkspacePath && plan.originWorkspacePath
        ? { targetWorkspacePath: plan.originWorkspacePath }
        : {}),
      ...(upgradeRunner ? { runner: upgradeRunner } : {}),
      status: 'executing',
      workflowKind: 'goal_self_driven',
      activation: {
        kind: 'accepted_goal',
        sourceMessageId: plan.activation?.sourceMessageId,
        acceptedAt,
        acceptedBy: 'user',
        intakeResolution: 'goal_confirmed',
      },
      revisionReason: patch.revisionReason || 'intake:goal_confirmed',
      changedBy: patch.changedBy || 'goal-runner:intake',
    });
  }

  function upsertGoalContract(conversationId, draft = {}) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const {
      revisionReason,
      changedBy,
      createdBy,
      ...planPatch
    } = draft;
    const conversationPlans = normalizedConversationId
      ? listPlanDetailsByConversation(normalizedConversationId)
      : [];
    let activeGoal = conversationPlans
      .filter((plan) => isActivePlan(plan) && isSelfDrivenGoal(plan))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]
      || null;
    if (!activeGoal) {
      return createGoalContract({ ...draft, conversationId: normalizedConversationId ?? draft.conversationId });
    }

    // intake 契约初始 status=executing；goal_create_plan 升级时若调用方显式
    // 传入 accepted，应采用该值，不能被旧的 executing 覆盖。否则 main 侧
    // auto-start 仅看 status===accepted 时会漏启动 Runner。
    const requestedStatus = typeof planPatch.status === 'string' ? planPatch.status : null;
    const safeStatus = requestedStatus
      || (activeGoal.status === 'accepted' || activeGoal.status === 'executing' || activeGoal.status === 'paused'
        ? activeGoal.status
        : 'accepted');
    const tasks = Array.isArray(planPatch.tasks) && planPatch.tasks.length > 0 ? planPatch.tasks : activeGoal.tasks;
    // intake → accepted_goal 原地升级时，确保 activation 与 resolution 与 promote 一致。
    const upgradingFromIntake = activeGoal.activation?.kind === 'intake'
      && (planPatch.activation?.kind === 'accepted_goal' || requestedStatus === 'accepted');
    const shouldEmitGoalAccepted = upgradingFromIntake;
    // 升级为 accepted_goal 时必须清掉 intake 残留：
    // 1) 未消费 interruption，否则 persist 会把计划派生回 failed / interrupted；
    // 2) 流错误收敛盖上的 waiting_user，否则 auto-start 闸门会当成真提问拦下 Runner。
    const upgradeRunner = shouldEmitGoalAccepted
      ? runnerPatchForAcceptedGoalUpgrade(activeGoal.runner)
      : undefined;
    return revisePlan(activeGoal.planId, {
      ...planPatch,
      conversationId: normalizedConversationId ?? activeGoal.conversationId,
      tasks,
      status: safeStatus,
      workflowKind: 'goal_self_driven',
      ...(upgradeRunner ? { runner: upgradeRunner } : {}),
      activation: {
        ...(activeGoal.activation || {}),
        ...(planPatch.activation || {}),
        kind: 'accepted_goal',
        acceptedAt: activeGoal.activation?.acceptedAt || planPatch.activation?.acceptedAt || new Date().toISOString(),
        acceptedBy: upgradingFromIntake
          ? (planPatch.activation?.acceptedBy || 'agent:goal_create_plan')
          : (planPatch.activation?.acceptedBy || activeGoal.activation?.acceptedBy),
      },
      intake: upgradingFromIntake
        ? {
          ...(activeGoal.intake || {}),
          ...(planPatch.intake || {}),
          resolution: 'goal_confirmed',
        }
        : (planPatch.intake || activeGoal.intake),
      executionPolicy: {
        ...(activeGoal.executionPolicy || DEFAULT_SELF_DRIVEN_POLICY),
        ...(planPatch.executionPolicy || {}),
        autonomy: 'self_driven',
      },
    }, {
      reason: revisionReason || (upgradingFromIntake ? 'intake:goal_confirmed' : '更新了目标内容'),
      changedBy: changedBy || createdBy || 'agent',
      changeKind: shouldEmitGoalAccepted ? 'goal-accepted' : 'persist',
    });
  }

  /**
   * 修订计划内容（先规划阶段的反复修改 / revise）。
   * 递增 version，并向 revisionHistory 追加一条。progress 自动重算。
   * 不允许通过本方法直接改 progress（会被忽略并重算）。
   */
  function revisePlan(planId, patch = {}, { reason, changedBy, changeKind = 'persist' } = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const { progress: _ignore, version: _v, revisionHistory: _rh, ...safePatch } = patch;
    // 修订若携带成功标准/验证结果，同样走结构化规范化（与 createPlan 一致，
    // 避免修订路径把结构化 DoD 退化成未校验的裸对象）。
    if ('successCriteria' in safePatch) {
      safePatch.successCriteria = normalizeSuccessCriteria(safePatch.successCriteria);
    }
    if ('criterionResults' in safePatch) {
      safePatch.criterionResults = normalizeCriterionResults(safePatch.criterionResults);
    }
    if ('manualConfirmations' in safePatch) {
      safePatch.manualConfirmations = normalizeManualConfirmations(safePatch.manualConfirmations);
    }
    if ('title' in safePatch) {
      const nextTitle = sanitizePlanTitle(safePatch.title, safePatch.goal ?? plan.goal);
      const previousTitle = typeof plan.title === 'string' ? plan.title.trim() : '';
      // 分析意图后允许刷新为更好的短标题；但空/占位/坏标题不要把已有好标题冲掉。
      if (
        nextTitle === '未命名任务'
        && previousTitle
        && previousTitle !== '未命名任务'
      ) {
        delete safePatch.title;
      } else {
        safePatch.title = nextTitle;
      }
    }
    const nextVersion = (plan.version || 1) + 1;
    const next = {
      ...plan,
      ...safePatch,
      version: nextVersion,
      revisionHistory: [
        ...(plan.revisionHistory || []),
        {
          version: nextVersion,
          reason: reason || '',
          changedAt: new Date().toISOString(),
          changedBy,
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    if (isAcceptanceClosePatch(plan.resultAcceptance, next.resultAcceptance)) {
      const knownRefs = new Set(collectHeldEvidenceRefs(plan));
      for (const record of readEvidenceIndex()) {
        if (evidenceRecordMatchesPlan(record, plan) && record.evidenceRef) {
          knownRefs.add(record.evidenceRef);
        }
      }
      assertAcceptanceCloseGate(next, { knownRefs: [...knownRefs] });
    }
    return persist(withRunTraceEvent(next, {
      type: 'plan_revised',
      summary: reason ? `计划有调整：${reason}` : '计划有调整',
      payload: {
        summaryCode: 'plan_revised',
        reason: reason || null,
        changedBy: changedBy || null,
        version: nextVersion,
      },
    }), { changeKind });
  }

  /**
   * 记录批准事实（Evidence），并按决策推进计划状态机：
   * - approve → 'approved'
   * - reject  → 回到 'drafting'
   * - revise  → 'drafting'（等待修订）
   */
  function recordApproval(planId, approval = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const decision = approval.decision;
    let status = plan.status;
    if (decision === 'approve') status = 'approved';
    else if (decision === 'reject') status = 'cancelled';
    else if (decision === 'revise') status = 'drafting';
    const workflowKind = plan.workflowKind || 'plan_approval';
    const next = {
      ...plan,
      approval: {
        decision,
        confirmationId: approval.confirmationId || randomUUID(),
        decidedBy: approval.decidedBy,
        decidedAt: approval.decidedAt || new Date().toISOString(),
        feedback: approval.feedback,
      },
      activation: decision === 'approve'
        ? { kind: 'approved_plan' }
        : normalizeActivation(plan.activation, workflowKind, status),
      executionPolicy: normalizeExecutionPolicy(plan.executionPolicy, workflowKind),
      status,
      updatedAt: new Date().toISOString(),
    };
    return persist(next);
  }

  /** 推进计划整体状态（executing / paused / completed / cancelled / failed）。 */
  function setPlanStatus(planId, status) {
    const plan = getPlan(planId);
    if (!plan) return null;
    // 显式状态写入保留调用方给定值（例如 stream_error → failed），
    // 不在此处被 derivePlanStatus 立即改写；后续 recordTaskEvidence 等
    // 叶子事实更新会重新派生，从而在任务全部成功时恢复 completed/executing。
    return persist(
      { ...plan, status, updatedAt: new Date().toISOString() },
      { preserveStatus: true },
    );
  }

  /**
   * 恢复 Goal Runner 执行：一次持久化同时恢复计划与 Runner，避免界面观察到中间态。
   * 历史 runTrace / problems 保持不变；仅清理当前失败字段。
   */
  function resumeRunner(planId, patch = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const current = normalizeRunnerState(plan.runner, planId) || {
      enabled: false,
      status: 'idle',
      turnCount: 0,
      roundCount: 0,
      toolCallCount: 0,
      explorerCount: 0,
      maxTurns: 8,
      maxToolCalls: 40,
      maxExplorers: 3,
      explorerConcurrency: DEFAULT_EXPLORER_CONCURRENCY,
      updatedAt: now,
    };
    const nextRunner = normalizeRunnerState({
      ...current,
      ...patch,
      enabled: true,
      status: 'running',
      blockerAudit: null,
      blockedReason: undefined,
      lastError: undefined,
      // 中断标记是「待用户确认的中断事实」，resume（继续执行）不应把它清掉，
      // 否则中断→继续链路会被 decideIntakeConvergence 误判为 pure_qa 并静默删除
      // （审计：mark_interrupted keep 后同一契约仍被 pure_qa→remove）。
      // 只有当调用方显式传入 consumedInterruption:true（用户明确放弃/接管）时才清除。
      ...(patch.consumedInterruption === true ? { interruption: undefined } : {}),
      updatedAt: patch.updatedAt || now,
    }, planId);
    return persist(
      { ...plan, status: 'executing', runner: nextRunner, updatedAt: now },
      { preserveStatus: true },
    );
  }

  /** 更新 Goal Runner 托管推进状态；不允许借此改写任务状态或 evidence。 */
  function setRunnerState(planId, patch = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const current = normalizeRunnerState(plan.runner, planId) || {
      enabled: false,
      status: 'idle',
      turnCount: 0,
      roundCount: 0,
      toolCallCount: 0,
      explorerCount: 0,
      maxTurns: 8,
      maxToolCalls: 40,
      maxExplorers: 3,
      explorerConcurrency: DEFAULT_EXPLORER_CONCURRENCY,
      updatedAt: now,
    };
    const nextRunner = normalizeRunnerState({ ...current, ...patch, updatedAt: patch.updatedAt || now }, planId);
    const changeKind = classifyRunnerChangeKind(patch);
    // 高频 overlay 与完整持久化共享同一最终状态校正；即使状态字符串未变化，
    // 也会修复 active runner 缺 segment / paused runner 仍开 segment 的历史脏状态。
    const timing = reconcileGoalTimingWithRunner(
      plan.timing,
      plan.status,
      nextRunner?.status,
      now,
    );
    const nextPlan = { ...plan, runner: nextRunner, updatedAt: now, ...(timing ? { timing } : {}) };

    // 高频 runner 进度：内存即时可见 + 广播 runner-progress（带 runner 本地 patch），
    // 写盘节流到 1s，避免 CLI 后台跑时跨进程刷新把 Desktop 打卡。
    if (changeKind === 'runner-progress') {
      const normalized = normalizePlan(nextPlan);
      const next = {
        ...normalized,
        status: derivePlanStatus(normalized.status, normalized.tasks),
        progress: aggregateProgress(normalized.tasks),
        ...(normalized.timing ? { timing: normalized.timing } : {}),
      };
      runnerProgressOverlay.set(planId, next);
      scheduleRunnerProgressPersist(planId);
      // soft progress：IPC 合并；硬状态跃迁仍走下面即时 persist 路径。
      scheduleRunnerProgressNotify(next.planId, next.conversationId ?? null);
      return next;
    }

    // 状态跃迁/终态等：立即 flush + 完整 persist（会清 overlay）。
    // 已在上面按 runner 调整 timing 时，把 prev 标成与 next 相同，避免 persist 因 plan 仍为
    // executing 而再次 open/close segment。
    return persist(nextPlan, {
      changeKind: 'runner-state',
      runner: nextRunner,
      prevStatus: plan.status,
      prevTiming: timing ?? plan.timing,
    });
  }

  /**
   * Persist request_user_input as the final action-owner transition of a turn.
   *
   * A model may complete the current leaf task and then ask the user to choose
   * the next direction in the same turn. In that sequence the question is the
   * final fact: reopen a just-completed plan and persist waiting_user so Task
   * Overview does not misclassify the turn as a result awaiting acceptance.
   *
   * Also used when the user clicks「继续讨论 / 继续追问」on a result_ready card:
   * that means acceptance failed and the same GoalPlan must leave the acceptance
   * queue (same card continues), instead of staying result_ready while a new
   * plan stacks on top.
   */
  function markRequestedUserInput(planId, runnerPatch = {}) {
    const plan = getPlan(planId);
    if (!plan || ['failed', 'cancelled'].includes(plan.status)) return null;

    const now = new Date().toISOString();
    const currentRunner = normalizeRunnerState(plan.runner, planId) || {
      enabled: false,
      status: 'idle',
      turnCount: 0,
      roundCount: 0,
      toolCallCount: 0,
      explorerCount: 0,
      maxTurns: 8,
      maxToolCalls: 40,
      maxExplorers: 3,
      explorerConcurrency: DEFAULT_EXPLORER_CONCURRENCY,
      updatedAt: now,
    };
    const nextRunner = normalizeRunnerState({
      ...currentRunner,
      ...runnerPatch,
      enabled: true,
      status: 'waiting_user',
      intent: 'block',
      phase: 'waiting_user',
      blockedReason: 'requested_user_input',
      lastError: undefined,
      updatedAt: now,
    }, planId);
    const timing = applyGoalTimingTransition(
      plan.timing,
      plan.status,
      'executing',
      currentRunner.status,
      nextRunner?.status,
      now,
    );

    const nextPlan = {
      ...plan,
      status: 'executing',
      runner: nextRunner,
      updatedAt: now,
      ...(timing ? { timing } : {}),
    };
    // 从待验收续接时清掉验收戳，避免同卡再被投影成已验收终态。
    if (plan.status === 'completed') {
      delete nextPlan.resultAcceptance;
    }
    return persist(nextPlan, {
      preserveStatus: true,
      changeKind: 'runner-state',
      runner: nextRunner,
      prevStatus: plan.status,
      prevTiming: plan.timing,
    });
  }

  /**
   * Consume a user reply to request_user_input as one persisted transition.
   * The Runner state and decision event must not diverge because Task Overview
   * projects its action owner directly from the persisted Runner.
   */
  function consumeRequestedUserInput(planId, event = {}) {
    const plan = getPlan(planId);
    if (!canConsumeRequestedUserInput(plan)) return null;

    const now = new Date().toISOString();
    const currentTrace = normalizeRunTrace(plan.runTrace, { goalPlanId: planId });
    const normalizedEvent = normalizeRunEvent({
      ...event,
      goalPlanId: planId,
      createdAt: event.createdAt || now,
    }, { goalPlanId: planId });
    if (!normalizedEvent) {
      throw new Error(`[goal-plan-store] invalid requested user input event for plan ${planId}`);
    }

    const currentRunner = normalizeRunnerState(plan.runner, planId) || {};
    const nextRunner = normalizeRunnerState({
      ...currentRunner,
      enabled: true,
      status: 'running',
      intent: 'execute',
      phase: ['waiting_user', 'blocked'].includes(currentRunner.phase) ? 'orient' : (currentRunner.phase || 'orient'),
      blockerAudit: null,
      blockedReason: undefined,
      lastError: undefined,
      updatedAt: now,
    }, planId);
    const timing = applyGoalTimingTransition(
      plan.timing,
      plan.status,
      plan.status,
      currentRunner.status,
      nextRunner?.status,
      now,
    );
    const nextTrace = {
      ...currentTrace,
      events: [...currentTrace.events, normalizedEvent],
    };
    const activeNodeId = normalizeOptionalString(event.activeNodeId) || normalizedEvent.nodeId;
    if (activeNodeId) nextTrace.activeNodeId = activeNodeId;

    return persist({
      ...plan,
      runner: nextRunner,
      runTrace: nextTrace,
      updatedAt: now,
      ...(timing ? { timing } : {}),
    }, {
      changeKind: 'runner-state',
      runner: nextRunner,
      prevStatus: plan.status,
      prevTiming: timing ?? plan.timing,
    });
  }

  /** Append a structured Goal / Plan / Run execution event without changing task Evidence. */
  function appendRunEvent(planId, event = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const current = normalizeRunTrace(plan.runTrace, { goalPlanId: planId });
    const normalizedEvent = normalizeRunEvent({
      ...event,
      goalPlanId: planId,
      createdAt: event.createdAt || now,
    }, { goalPlanId: planId });
    if (!normalizedEvent) {
      throw new Error(`[goal-plan-store] invalid run event for plan ${planId}`);
    }
    const nextTrace = {
      ...current,
      events: [...current.events, normalizedEvent],
    };
    const activeNodeId = normalizeOptionalString(event.activeNodeId) || normalizedEvent.nodeId;
    if (activeNodeId) nextTrace.activeNodeId = activeNodeId;
    if (normalizedEvent.type === 'checkpoint_created' && activeNodeId) {
      nextTrace.lastCheckpointNodeId = activeNodeId;
    }
    return persist({ ...plan, runTrace: nextTrace, updatedAt: now });
  }

  /** 动态派发只读 Explorer 子 Agent 实例；只记录运行契约，不改写任务状态或 Evidence。 */
  function dispatchExplorer(planId, request = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const current = normalizeRunnerState(plan.runner, planId) || {
      enabled: true,
      status: 'idle',
      turnCount: 0,
      toolCallCount: 0,
      explorerCount: 0,
      maxTurns: 8,
      maxToolCalls: 40,
      maxExplorers: 3,
      explorerConcurrency: DEFAULT_EXPLORER_CONCURRENCY,
      updatedAt: now,
    };
    // 并发模型：不再对「每计划累计 Explorer 总数」设闸（该累计上限语义已弃用），
    // 计划总数由 runner 的 maxTurns 天然兜底；每 turn 的并发上限由 goal-runner 侧的
    // explorerConcurrency 并发池控制。此处只负责登记本次派发。
    const explorers = Array.isArray(current.explorers) ? current.explorers : [];
    const batchId = typeof request.batchId === 'string' && request.batchId.trim()
      ? request.batchId.trim()
      : undefined;
    const explorerId = typeof request.explorerId === 'string' && request.explorerId.trim()
      ? request.explorerId.trim()
      : randomUUID();
    const explorerRun = normalizeExplorerRun({
      explorerId,
      status: request.status || 'queued',
      request: { ...request, explorerId, planId },
      batchId,
      createdAt: request.createdAt || now,
      updatedAt: request.updatedAt || now,
    }, { explorerId, planId, batchId });
    if (!explorerRun) {
      throw new Error(`[goal-plan-store] invalid explorer request for plan ${planId}`);
    }
    const nextExplorers = [...explorers, explorerRun];
    const nextRunner = normalizeRunnerState({
      ...current,
      enabled: true,
      status: 'exploring',
      intent: 'explore',
      explorerCount: countExplorerRuns(nextExplorers),
      explorers: nextExplorers,
      // 本轮进度：属于同一 batchId 的 Explorer 归集为一批（total 递增、done 从 0 起）。
      // 无 batchId（旧单发路径）时保持既有 batch 不变。
      explorerBatch: batchId ? computeExplorerBatch(nextExplorers, batchId) : current.explorerBatch,
      updatedAt: now,
    }, planId);
    return persist({ ...plan, runner: nextRunner, updatedAt: now });
  }

  /** 回填 Explorer 报告；完成态必须引用本次 Explorer 工具执行产生的 evidenceRefs。 */
  function reportExplorer(planId, explorerId, report = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const current = normalizeRunnerState(plan.runner, planId);
    if (!current) return null;
    const explorers = Array.isArray(current.explorers) ? current.explorers : [];
    const index = explorers.findIndex((run) => run.explorerId === explorerId);
    if (index < 0) return null;
    const status = EXPLORER_STATUSES.has(report.status) ? report.status : 'completed';
    const normalizedReport = normalizeExplorerReport({
      ...report,
      explorerId,
      planId,
      question: report.question || explorers[index].request?.question,
      createdAt: report.createdAt || now,
    });
    const registeredEvidenceRefs = normalizeExplorerRegistryRefs(report, explorers[index]);
    if (status === 'completed') {
      assertExplorerReportEvidenceRegistered({
        explorerId,
        report: normalizedReport,
        registeredRefs: registeredEvidenceRefs,
      });
    }
    const nextRun = normalizeExplorerRun({
      ...explorers[index],
      status,
      report: normalizedReport,
      evidenceRefs: registeredEvidenceRefs,
      failureReason: report.failureReason,
      updatedAt: report.updatedAt || now,
    }, { explorerId, planId });
    const nextExplorers = explorers.map((run, idx) => (idx === index ? nextRun : run));
    const stillRunning = nextExplorers.some((run) => run.status === 'queued' || run.status === 'running');
    // 本轮进度：以被回填 Explorer 所属 batch 重算 done/total；该 explorer 不属于任何
    // batch（旧单发路径）时保持既有 batch 不变。
    const reportedBatchId = nextRun.batchId;
    const nextRunner = normalizeRunnerState({
      ...current,
      status: stillRunning ? 'exploring' : 'idle',
      intent: stillRunning ? 'explore' : 'verify',
      explorerCount: countExplorerRuns(nextExplorers),
      explorers: nextExplorers,
      explorerBatch: reportedBatchId
        ? computeExplorerBatch(nextExplorers, reportedBatchId)
        : current.explorerBatch,
      updatedAt: now,
    }, planId);
    return persist({ ...plan, runner: nextRunner, updatedAt: now });
  }

  /**
   * 记录 Verifier 运行事实。VerifierRun 是验证动作的审计轨迹，不替代任务 Evidence
   * 或 CriterionResult；实际完成/通过仍分别由 recordTaskEvidence / recordCriterionResults
   * 明确回写。
   */
  function recordVerifierRun(planId, run = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const verifierRunId = typeof run.verifierRunId === 'string' && run.verifierRunId.trim()
      ? run.verifierRunId.trim()
      : randomUUID();
    const nextRun = normalizeVerifierRun({
      ...run,
      verifierRunId,
      planId,
      updatedAt: run.updatedAt || now,
    }, { verifierRunId, planId });
    if (!nextRun) {
      throw new Error(`[goal-plan-store] invalid verifier run for plan ${planId}`);
    }
    if (nextRun.target.kind === 'task' && !taskExistsInTree(plan.tasks, nextRun.target.taskId)) {
      throw new Error(
        `[goal-plan-store] verifier target task ${nextRun.target.taskId} not found in plan ${planId}`,
      );
    }
    if (nextRun.target.kind === 'success_criterion') {
      const knownIds = new Set(
        (Array.isArray(plan.successCriteria) ? plan.successCriteria : [])
          .map((c) => (c && typeof c.id === 'string' ? c.id : null))
          .filter(Boolean),
      );
      if (!knownIds.has(nextRun.target.criterionId)) {
        throw new Error(
          `[goal-plan-store] verifier target criterion ${nextRun.target.criterionId} not found in plan ${planId}`,
        );
      }
    }
    if (nextRun.status === 'passed' && nextRun.evidenceRefs.length === 0) {
      throw new Error(
        `[goal-plan-store] verifier run ${verifierRunId} cannot be 'passed' without evidenceRefs`,
      );
    }
    const current = normalizeRunnerState(plan.runner, planId) || {
      enabled: false,
      status: 'idle',
      turnCount: 0,
      roundCount: 0,
      toolCallCount: 0,
      explorerCount: 0,
      maxTurns: 8,
      maxToolCalls: 40,
      maxExplorers: 3,
      explorerConcurrency: DEFAULT_EXPLORER_CONCURRENCY,
      updatedAt: now,
    };
    const verifierRuns = Array.isArray(current.verifierRuns) ? current.verifierRuns : [];
    const index = verifierRuns.findIndex((item) => item.verifierRunId === verifierRunId);
    const nextVerifierRuns = index >= 0
      ? verifierRuns.map((item, idx) => (idx === index ? nextRun : item))
      : [...verifierRuns, nextRun];
    const nextRunner = normalizeRunnerState({
      ...current,
      verifierRuns: nextVerifierRuns,
      updatedAt: now,
    }, planId);
    return persist({ ...plan, runner: nextRunner, updatedAt: now });
  }

  /**
   * 由 Evidence 回写子任务状态。约束（提案 §6）：
   * - 置为 'completed' 必须提供非空 evidenceRefs，否则抛错。
   * - progress 在 persist 时自动重算。
   *
   * @param {string} planId
   * @param {string} taskId
   * @param {{status:string, evidenceRefs?:string[], result?:string,
   *          failureReason?:string, blockedReason?:string}} change
   */
  function recordTaskEvidence(planId, taskId, change = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const { status } = change;
    // Layer B 护栏：批准闸门守在源头。
    // 计划在批准前（drafting / awaiting_approval）不允许把任何子任务标成
    // 「开工/终结」态（running / completed / failed / waiting_user）——否则会绕过
    // 面板审批直接触发执行语义，并与 derivePlanStatus 规则 1 一起制造僵死态。
    // 只有 recordApproval 把计划推进到 approved 之后，任务才能进入这些状态。
    const PRE_APPROVAL_PLAN = new Set(['drafting', 'awaiting_approval']);
    const EXECUTION_TASK_STATUS = new Set([
      'running',
      TERMINAL_OK,
      TERMINAL_FAIL,
      TERMINAL_CANCEL,
      'waiting_user',
    ]);
    if (
      status !== undefined &&
      EXECUTION_TASK_STATUS.has(status) &&
      goalPlanRequiresApproval(plan) &&
      PRE_APPROVAL_PLAN.has(plan.status)
    ) {
      throw new Error(
        `[goal-plan-store] task ${taskId} cannot enter '${status}' before plan ${planId} is approved (plan status: '${plan.status}')`,
      );
    }
    const mergedRefs = (refs, add) => {
      const set = new Set([
        ...normalizeEvidenceRefList(refs),
        ...normalizeEvidenceRefList(add),
      ]);
      return [...set];
    };
    const existingTask = findTaskInTree(plan.tasks, taskId);
    if (!existingTask) {
      throw new Error(`[goal-plan-store] task ${taskId} not found in plan ${planId}`);
    }
    if (status === TERMINAL_OK) {
      const incoming = normalizeEvidenceRefList(change.evidenceRefs);
      const evidenceRefs = mergedRefs(existingTask.evidenceRefs, incoming);
      if (evidenceRefs.length === 0) {
        throw new Error(
          `[goal-plan-store] task ${taskId} cannot be 'completed' without evidenceRefs`,
        );
      }
      assertAnyEvidenceRefIndexed(plan, evidenceRefs, `task ${taskId}`);
    }
    const now = new Date().toISOString();
    const { tasks, found } = updateTaskInTree(plan.tasks, taskId, (t) => {
      const nextRefs = mergedRefs(t.evidenceRefs, change.evidenceRefs);
      const updated = {
        ...t,
        status: status ?? t.status,
        evidenceRefs: nextRefs,
      };
      if (change.result !== undefined) updated.result = change.result;
      if (change.failureReason !== undefined) updated.failureReason = change.failureReason;
      if (change.blockedReason !== undefined) updated.blockedReason = change.blockedReason;
      if (status === 'running' && !t.startedAt) updated.startedAt = now;
      if (status === TERMINAL_OK || status === TERMINAL_FAIL || status === TERMINAL_CANCEL) {
        updated.completedAt = now;
      }
      return updated;
    });
    if (!found) throw new Error(`[goal-plan-store] task ${taskId} not found in plan ${planId}`);
    const updatedPlan = persist({ ...plan, tasks, updatedAt: now });
    if (updatedPlan.parentPlanId && updatedPlan.sourceTaskId) {
      const childTasks = [];
      const collectChildLeaves = (tasks) => {
        for (const task of tasks || []) {
          if (Array.isArray(task.subtasks) && task.subtasks.length > 0) collectChildLeaves(task.subtasks);
          else childTasks.push(task);
        }
      };
      collectChildLeaves(updatedPlan.tasks);
      const childFailed = childTasks.some((task) => task.status === TERMINAL_FAIL || task.status === BLOCKED);
      const childComplete = childTasks.length > 0
        && childTasks.every((task) => LEAF_TERMINAL_STATUSES.has(task.status))
        && !childFailed;
      const childStarted = childTasks.some((task) => task.status !== 'pending');
      const delegatedStatus = childFailed
        ? BLOCKED
        : childComplete
          ? 'waiting_user'
          : childStarted
            ? 'running'
            : 'pending';
      const parent = getPlan(updatedPlan.parentPlanId);
      if (parent) {
        const linked = updateTaskInTree(parent.tasks, updatedPlan.sourceTaskId, (task) => ({
          ...task,
          status: delegatedStatus,
          executionMode: 'delegated',
          childPlanIds: [...new Set([...(task.childPlanIds || []), updatedPlan.planId])],
          ...(childFailed ? { blockedReason: `派生子目标 ${updatedPlan.title} 未成功完成` } : {}),
        }));
        if (linked.found) {
          persist({ ...parent, tasks: linked.tasks, updatedAt: now });
          const relationEventType = childFailed
            ? 'child_goal_failed'
            : childComplete
              ? 'child_goal_completed'
              : childStarted
                ? 'child_goal_started'
                : null;
          if (relationEventType) {
            const payload = {
              parentPlanId: parent.planId,
              childPlanId: updatedPlan.planId,
              sourceTaskId: updatedPlan.sourceTaskId,
              rootPlanId: updatedPlan.rootPlanId,
            };
            const previous = [...(updatedPlan.runTrace?.events || [])].reverse().find((event) =>
              event.type === relationEventType && event.payload?.parentPlanId === parent.planId,
            );
            if (!previous) {
              appendRunEvent(parent.planId, {
                type: relationEventType,
                taskId: updatedPlan.sourceTaskId,
                payload,
              });
              appendRunEvent(updatedPlan.planId, {
                type: relationEventType,
                taskId,
                payload,
              });
            }
          }
        }
      }
    }
    return getPlan(updatedPlan.planId);
  }

  /**
   * 用户改向/撤回剩余工作时，把未终态叶子标成 cancelled。
   * persist 会按叶子事实把计划收尾为 completed（含 cancelled 叶子），泵即可停。
   */
  function cancelOpenTasks(planId, { reason } = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const note = typeof reason === 'string' && reason.trim()
      ? reason.trim()
      : '用户撤回剩余工作';
    let cancelledCount = 0;
    const walk = (list) => (list || []).map((task) => {
      const children = Array.isArray(task.subtasks) ? task.subtasks : [];
      if (children.length > 0) return { ...task, subtasks: walk(children) };
      if (LEAF_TERMINAL_STATUSES.has(task.status)) return task;
      cancelledCount += 1;
      return {
        ...task,
        status: TERMINAL_CANCEL,
        blockedReason: note,
        completedAt: now,
      };
    });
    const tasks = walk(plan.tasks);
    if (cancelledCount === 0) return plan;
    return persist({ ...plan, tasks, updatedAt: now });
  }

  /**
   * 回写成功标准（DoD）的验证结果 —— DoD-as-Code 的落盘入口。
   *
   * post-act 阶段，Runner 对可自动验证的 successCriterion 跑验证（命令/测试/文件检查），
   * 把 Tool Result 作为 evidenceRef 连同 passed 一并回写。按 criterionId 合并：同一
   * criterionId 的新结果覆盖旧结果，其余保留。仅接受计划已声明的 criterionId，避免
   * 凭空造标准绕过完成门。
   *
   * @param {string} planId
   * @param {Array} results CriterionResult[]（criterionId/passed/evidenceRef/detail）
   */
  function recordCriterionResults(planId, results = []) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const incoming = normalizeCriterionResults(results);
    if (incoming.length === 0) return plan;
    const now = new Date().toISOString();
    // 只接受计划已声明的 criterionId，防止捏造标准。
    const knownCriteria = new Map(
      (Array.isArray(plan.successCriteria) ? plan.successCriteria : [])
        .map((c) => (c && typeof c.id === 'string' ? [c.id, c] : null))
        .filter(Boolean),
    );
    const byId = new Map(
      (Array.isArray(plan.criterionResults) ? plan.criterionResults : []).map((r) => [
        r.criterionId,
        r,
      ]),
    );
    for (const r of incoming) {
      const criterion = knownCriteria.get(r.criterionId);
      if (!criterion) continue;
      if (r.passed && AUTO_CRITERION_KINDS.has(criterion.kind) && !r.evidenceRef) {
        throw new Error(
          `[goal-plan-store] criterion ${r.criterionId} cannot be passed without evidenceRef`,
        );
      }
      if (r.evidenceRef) {
        assertEvidenceRefIndexed(plan, r.evidenceRef, `criterion ${r.criterionId}`);
      }
      byId.set(r.criterionId, { ...r, checkedAt: r.checkedAt || now });
    }
    return persist({ ...plan, criterionResults: [...byId.values()], updatedAt: now });
  }

  function recordQualityReview(planId, review = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const qualityReview = normalizeQualityReview(review);
    if (!qualityReview) return plan;
    const now = new Date().toISOString();
    const next = {
      ...plan,
      qualityReview,
      updatedAt: now,
    };
    // 质检已通过时，过期的 quality_review_pending 不再代表真实阻断。
    if (
      qualityReview.status === 'passed'
      && plan.deliveryHandoff?.status === 'stopped'
      && plan.deliveryHandoff?.stoppedReason === 'quality_review_pending'
    ) {
      const { stoppedReason: _stalePending, ...restHandoff } = plan.deliveryHandoff;
      next.deliveryHandoff = {
        ...restHandoff,
        status: 'idle',
        updatedAt: now,
      };
    }
    return persist(next);
  }

  function recordDeliveryHandoff(planId, handoff = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const deliveryHandoff = normalizeDeliveryHandoff({
      ...handoff,
      updatedAt: handoff.updatedAt || new Date().toISOString(),
    });
    if (!deliveryHandoff) return plan;
    return persist({
      ...plan,
      deliveryHandoff,
      updatedAt: deliveryHandoff.updatedAt,
    });
  }

  function recordDeliveryIsolation(planId, isolation = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const nextBinding = normalizeDeliveryBinding({
      ...(plan.deliveryBinding && typeof plan.deliveryBinding === 'object' ? plan.deliveryBinding : {}),
      repoId: isolation.repoId ?? plan.deliveryBinding?.repoId ?? plan.targetRepoId,
      targetBranch: isolation.targetBranch ?? plan.deliveryBinding?.targetBranch ?? plan.targetBranch,
      targetBranchSource: isolation.targetBranchSource
        ?? plan.deliveryBinding?.targetBranchSource
        ?? plan.targetBranchSource,
      targetWorkspacePath: isolation.targetWorkspacePath
        ?? plan.deliveryBinding?.targetWorkspacePath
        ?? plan.targetWorkspacePath,
      baseCommit: isolation.baseCommit ?? plan.deliveryBinding?.baseCommit ?? plan.baseCommit,
      executionIsolation: isolation.executionIsolation ?? 'worktree',
      taskBranch: isolation.taskBranch,
      worktreePath: isolation.worktreePath,
      boundAt: plan.deliveryBinding?.boundAt,
    }, {
      targetWorkspacePath: plan.targetWorkspacePath,
      baseCommit: plan.baseCommit,
    });
    if (!nextBinding) return plan;
    return persist({
      ...plan,
      deliveryBinding: nextBinding,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 记录 Manual DoD 的人工确认事实。
   *
   * 这条链路不同于 plan approval：它只在完成门前确认无法自动验证的成功标准，
   * 不授予执行权限，也不替代任务 Evidence / 自动 CriterionResult。
   */
  function recordManualConfirmation(planId, confirmation = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const decision = CONFIRMATION_DECISIONS.has(confirmation.decision)
      ? confirmation.decision
      : null;
    if (!decision) {
      throw new Error(`[goal-plan-store] manual confirmation for plan ${planId} requires a valid decision`);
    }
    const manualCriterionIds = collectManualCriterionIds(plan);
    if (manualCriterionIds.length === 0) {
      throw new Error(`[goal-plan-store] plan ${planId} has no manual success criteria to confirm`);
    }
    const manualSet = new Set(manualCriterionIds);
    const requestedIds = normalizeStringArray(confirmation.criterionIds);
    const criterionIds = requestedIds.length > 0 ? requestedIds : manualCriterionIds;
    const unknownIds = criterionIds.filter((id) => !manualSet.has(id));
    if (unknownIds.length > 0) {
      throw new Error(
        `[goal-plan-store] manual confirmation references unknown manual criteria: ${unknownIds.join(', ')}`,
      );
    }
    const record = normalizeManualConfirmation({
      ...confirmation,
      kind: 'manual_dod',
      decision,
      criterionIds,
      decidedAt: confirmation.decidedAt || new Date().toISOString(),
    });
    if (!record) {
      throw new Error(`[goal-plan-store] invalid manual confirmation for plan ${planId}`);
    }
    return persist({
      ...plan,
      manualConfirmations: [
        ...(Array.isArray(plan.manualConfirmations) ? plan.manualConfirmations : []),
        record,
      ],
      updatedAt: new Date().toISOString(),
    });
  }

  function deletePlan(planId) {
    // 删除前尽量取出 conversationId，便于 renderer 会话过滤。
    const existing = getPlan(planId);
    const conversationId = existing?.conversationId ?? null;
    clearRunnerProgressState(planId);
    const index = readIndex().filter((m) => m.planId !== planId);
    writeIndex( index);
    try {
      if (existsSync(planFile(planId))) unlinkSync(planFile(planId));
    } catch {}
    publishPersistedChange('delete', planId, {
      conversationId,
      changeKind: 'delete',
    });
    return listPlans();
  }

  /**
   * intake 收敛审计（追加式 JSONL，见 peer-knowledge intake-convergence 文档）。
   *
   * 每行一条结构化事件，用于定量回答「并发/中断漏了多少任务」：
   * - action=delete_plan：intake 契约被收敛器判为纯问答而静默删除（每次 deletePlan 前）。
   * - action=mark_interrupted：intake 契约首答被打断，升级为「待用户确认」打标。
   *
   * 写入失败只告警，绝不阻塞主流程（与 writeGoalChangeEvent 同策略）。
   *
   * @param {object} entry { action, decision, reason, conversationId, planId, terminalStatus }
   */
  function appendIntakeConvergenceAudit(entry = {}) {
    try {
      appendJsonl(path.join(storeDir, 'intake-convergence.jsonl'), {
        event: 'intake_convergence',
        ...entry,
        createdAt: new Date().toISOString(),
        writerPid: process.pid,
      });
    } catch (error) {
      console.warn('[goal-plan-store] intake convergence audit failed:', error?.message || error);
    }
  }

  /**
   * 级联删除：硬删除某个会话名下的全部计划（见 ADR 34）。
   *
   * 用于「删除会话」时联动清理其计划，避免孤儿计划文件/索引行。
   * 设计约束：
   * - conversationId 归一化为 null（空/未传）时直接 no-op，绝不按 `null === null`
   *   去匹配——否则会误删那些「未关联任何会话」的计划。
   * - 基于 index 行的 conversationId 即可筛选，无需逐个读 plan 文件。
   * - 原子重写 index（一次写盘），再逐个 unlink 计划文件；删除若干计划只广播一次
   *   onChange，复用既有 Seam（renderer 仍走 goalPlans:changed 刷新）。
   *
   * @param {string|null|undefined} conversationId 目标会话 id
   * @returns {Array} 删除后剩余的计划元信息列表（listPlans 形态）
   */
  function deletePlanByConversation(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    // 空会话 id 是 no-op：不删除任何计划（尤其不能误删未关联会话的计划）。
    if (normalizedConversationId === null) return listPlans();

    const index = readIndex();
    const removed = index.filter(
      (m) => normalizeConversationId(m.conversationId) === normalizedConversationId,
    );
    if (removed.length === 0) return listPlans();

    const remaining = index.filter(
      (m) => normalizeConversationId(m.conversationId) !== normalizedConversationId,
    );
    // 先原子重写 index（一次写盘），再删除各计划文件。
    writeIndex( remaining);
    for (const meta of removed) {
      try {
        if (existsSync(planFile(meta.planId))) unlinkSync(planFile(meta.planId));
      } catch {}
    }
    // 批量删除只广播一次，避免抖动；planId 传 null 表示非单一计划变更。
    for (const meta of removed) clearRunnerProgressState(meta.planId);
    publishPersistedChange('delete', null, {
      conversationId: normalizedConversationId,
      changeKind: 'delete',
    });
    return listPlans();
  }


  function ensureRunnerRunId(plan, nowIso) {
    const current = normalizeRunnerState(plan.runner, plan.planId) || {
      enabled: false,
      status: 'idle',
      turnCount: 0,
      roundCount: 0,
      toolCallCount: 0,
      explorerCount: 0,
      maxTurns: 8,
      maxToolCalls: 40,
      maxExplorers: 3,
      explorerConcurrency: DEFAULT_EXPLORER_CONCURRENCY,
      updatedAt: nowIso,
    };
    if (current.runId) return { plan, runner: current };
    const runId = `run-${nowIso.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
    const nextRunner = { ...current, runId, updatedAt: nowIso };
    const nextPlan = persist({ ...plan, runner: nextRunner, updatedAt: nowIso });
    return { plan: nextPlan, runner: nextRunner };
  }

  /**
   * Prepare a Goal context checkpoint (write-ahead before destructive compaction).
   * CAS on plan.version / runId / previous checkpoint id.
   */
  function prepareContextCheckpoint(planId, input = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const nowIso = new Date().toISOString();
    const ensured = ensureRunnerRunId(plan, nowIso);
    const currentPlan = ensured.plan;
    const runner = ensured.runner;
    const expectedPlanVersion = Number.isFinite(input.expectedPlanVersion)
      ? Math.trunc(input.expectedPlanVersion)
      : currentPlan.version;
    if (currentPlan.version !== expectedPlanVersion) {
      const err = new Error(`[goal-plan-store] prepareContextCheckpoint CAS conflict on plan version`);
      err.code = 'GOAL_CHECKPOINT_CONFLICT';
      throw err;
    }
    if (input.expectedRunId && runner.runId && input.expectedRunId !== runner.runId) {
      const err = new Error(`[goal-plan-store] prepareContextCheckpoint CAS conflict on runId`);
      err.code = 'GOAL_CHECKPOINT_CONFLICT';
      throw err;
    }
    const previous = runner.contextCheckpoint && typeof runner.contextCheckpoint === 'object'
      ? runner.contextCheckpoint
      : null;
    if (input.expectedPreviousCheckpointId) {
      const prevId = previous?.checkpointId || null;
      if (prevId !== input.expectedPreviousCheckpointId) {
        const err = new Error(`[goal-plan-store] prepareContextCheckpoint CAS conflict on previous checkpoint`);
        err.code = 'GOAL_CHECKPOINT_CONFLICT';
        throw err;
      }
    }

    const checkpoint = normalizeGoalCheckpoint({
      ...(input.checkpoint && typeof input.checkpoint === 'object' ? input.checkpoint : {}),
      status: 'preparing',
      planId: currentPlan.planId,
      planVersion: currentPlan.version,
      runId: runner.runId,
      conversationId: currentPlan.conversationId || input.conversationId || undefined,
      currentTaskId: input.currentTaskId || runner.currentTaskId || undefined,
      runnerPhase: input.runnerPhase || runner.phase || undefined,
      runnerIntent: input.runnerIntent || runner.intent || undefined,
      sequence: Number.isFinite(input.sequence)
        ? Math.trunc(input.sequence)
        : (Number.isFinite(previous?.sequence)
          ? Math.trunc(previous.sequence) + 1
          : (Number.isFinite(runner.lastConsumedCheckpointSequence)
            ? Math.trunc(runner.lastConsumedCheckpointSequence) + 1
            : 1)),
      reason: input.reason || input.checkpoint?.reason || 'soft_threshold',
      createdAt: nowIso,
    }, {
      fallbackPlanId: currentPlan.planId,
      fallbackRunId: runner.runId,
      fallbackPlanVersion: currentPlan.version,
      now: nowIso,
    });

    const nextRunner = normalizeRunnerState({
      ...runner,
      enabled: true,
      status: 'compacting_context',
      runId: runner.runId,
      contextCheckpoint: checkpoint,
      updatedAt: nowIso,
    }, currentPlan.planId);

    const nextPlan = persist({
      ...currentPlan,
      runner: nextRunner,
      updatedAt: nowIso,
    });

    try {
      appendRunEvent(planId, {
        type: 'goal_checkpoint_prepared',
        summary: `Prepared context checkpoint ${checkpoint.checkpointId}`,
        payload: {
          checkpointId: checkpoint.checkpointId,
          sequence: checkpoint.sequence,
          digest: checkpoint.digest,
          reason: checkpoint.reason,
          currentTaskId: checkpoint.currentTaskId || null,
        },
      });
    } catch {
      // Event append failure must not roll back the prepared checkpoint.
    }

    return getPlan(planId) || nextPlan;
  }

  function commitContextCheckpoint(planId, input = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const nowIso = new Date().toISOString();
    const runner = normalizeRunnerState(plan.runner, planId) || {
      enabled: true,
      status: 'compacting_context',
      turnCount: 0,
      roundCount: 0,
      toolCallCount: 0,
      explorerCount: 0,
      maxTurns: 8,
      maxToolCalls: 40,
      maxExplorers: 3,
      explorerConcurrency: DEFAULT_EXPLORER_CONCURRENCY,
      updatedAt: nowIso,
    };

    const expectedPlanVersion = Number.isFinite(input.expectedPlanVersion)
      ? Math.trunc(input.expectedPlanVersion)
      : plan.version;
    if (plan.version !== expectedPlanVersion) {
      const err = new Error('[goal-plan-store] commitContextCheckpoint CAS conflict on plan version');
      err.code = 'GOAL_CHECKPOINT_CONFLICT';
      throw err;
    }
    if (input.expectedRunId && runner.runId && input.expectedRunId !== runner.runId) {
      const err = new Error('[goal-plan-store] commitContextCheckpoint CAS conflict on runId');
      err.code = 'GOAL_CHECKPOINT_CONFLICT';
      throw err;
    }

    const preparing = runner.contextCheckpoint;
    const source = input.checkpoint && typeof input.checkpoint === 'object'
      ? input.checkpoint
      : preparing;
    if (!source) {
      const err = new Error('[goal-plan-store] commitContextCheckpoint requires a checkpoint');
      err.code = 'GOAL_CHECKPOINT_INVALID';
      throw err;
    }
    if (input.expectedPreviousCheckpointId) {
      // When committing an update, previous id is the preparing checkpoint id.
      const prevId = preparing?.checkpointId || null;
      if (prevId && prevId !== input.expectedPreviousCheckpointId && source.checkpointId !== input.expectedPreviousCheckpointId) {
        const err = new Error('[goal-plan-store] commitContextCheckpoint CAS conflict on previous checkpoint');
        err.code = 'GOAL_CHECKPOINT_CONFLICT';
        throw err;
      }
    }

    const checkpoint = normalizeGoalCheckpoint({
      ...source,
      status: 'committed',
      committedAt: nowIso,
      planId: plan.planId,
      planVersion: plan.version,
      runId: runner.runId || source.runId,
    }, {
      fallbackPlanId: plan.planId,
      fallbackRunId: runner.runId || plan.planId,
      fallbackPlanVersion: plan.version,
      now: nowIso,
    });
    const validated = validateGoalCheckpoint(checkpoint);
    if (!validated.ok) {
      const err = new Error(`[goal-plan-store] invalid checkpoint: ${validated.errors.join('; ')}`);
      err.code = 'GOAL_CHECKPOINT_INVALID';
      throw err;
    }

    const nextRunner = normalizeRunnerState({
      ...runner,
      enabled: true,
      status: 'compacting_context',
      runId: checkpoint.runId,
      contextCheckpoint: validated.checkpoint,
      updatedAt: nowIso,
    }, plan.planId);

    const nextPlan = persist({
      ...plan,
      runner: nextRunner,
      updatedAt: nowIso,
    });

    try {
      appendRunEvent(planId, {
        type: 'goal_checkpoint_committed',
        summary: `Committed context checkpoint ${checkpoint.checkpointId}`,
        payload: {
          checkpointId: checkpoint.checkpointId,
          sequence: checkpoint.sequence,
          digest: checkpoint.digest,
          reason: checkpoint.reason,
          currentTaskId: checkpoint.currentTaskId || null,
        },
      });
    } catch {
      // non-fatal
    }

    return getPlan(planId) || nextPlan;
  }

  function markContextCompactionPersisted(planId, input = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const nowIso = new Date().toISOString();
    const runner = normalizeRunnerState(plan.runner, planId);
    if (!runner?.contextCheckpoint) return plan;
    const cp = runner.contextCheckpoint;
    if (input.checkpointId && cp.checkpointId !== input.checkpointId) {
      const err = new Error('[goal-plan-store] markContextCompactionPersisted checkpoint mismatch');
      err.code = 'GOAL_CHECKPOINT_CONFLICT';
      throw err;
    }
    const nextCheckpoint = normalizeGoalCheckpoint({
      ...cp,
      status: 'committed',
      conversationRevision: input.conversationRevision || cp.conversationRevision,
      committedAt: cp.committedAt || nowIso,
    }, {
      fallbackPlanId: plan.planId,
      fallbackRunId: runner.runId || plan.planId,
      now: nowIso,
    });
    const nextRunner = normalizeRunnerState({
      ...runner,
      status: input.runnerStatus || 'resuming_after_compaction',
      compactionCount: (Number.isFinite(runner.compactionCount) ? runner.compactionCount : 0) + 1,
      lastCompactionAt: nowIso,
      contextCheckpoint: nextCheckpoint,
      updatedAt: nowIso,
    }, plan.planId);
    const nextPlan = persist({ ...plan, runner: nextRunner, updatedAt: nowIso });
    try {
      appendRunEvent(planId, {
        type: 'goal_compaction_persisted',
        summary: `Persisted compaction for checkpoint ${nextCheckpoint.checkpointId}`,
        payload: {
          checkpointId: nextCheckpoint.checkpointId,
          sequence: nextCheckpoint.sequence,
          conversationRevision: nextCheckpoint.conversationRevision || null,
        },
      });
    } catch {
      // non-fatal
    }
    return getPlan(planId) || nextPlan;
  }

  function markContextCheckpointConsumed(planId, input = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const nowIso = new Date().toISOString();
    const runner = normalizeRunnerState(plan.runner, planId);
    if (!runner?.contextCheckpoint) return plan;
    const cp = runner.contextCheckpoint;
    if (input.checkpointId && cp.checkpointId !== input.checkpointId) {
      const err = new Error('[goal-plan-store] markContextCheckpointConsumed checkpoint mismatch');
      err.code = 'GOAL_CHECKPOINT_CONFLICT';
      throw err;
    }
    const consumed = normalizeGoalCheckpoint({
      ...cp,
      status: 'consumed',
      consumedAt: nowIso,
    }, {
      fallbackPlanId: plan.planId,
      fallbackRunId: runner.runId || plan.planId,
      now: nowIso,
    });
    const nextRunner = normalizeRunnerState({
      ...runner,
      status: input.runnerStatus || 'running',
      contextCheckpoint: undefined,
      lastConsumedCheckpointId: consumed.checkpointId,
      lastConsumedCheckpointSequence: consumed.sequence,
      updatedAt: nowIso,
    }, plan.planId);
    const nextPlan = persist({ ...plan, runner: nextRunner, updatedAt: nowIso });
    try {
      appendRunEvent(planId, {
        type: 'goal_checkpoint_consumed',
        summary: `Consumed context checkpoint ${consumed.checkpointId}`,
        payload: {
          checkpointId: consumed.checkpointId,
          sequence: consumed.sequence,
        },
      });
    } catch {
      // non-fatal
    }
    return getPlan(planId) || nextPlan;
  }

  function supersedeContextCheckpoint(planId, input = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const nowIso = new Date().toISOString();
    const runner = normalizeRunnerState(plan.runner, planId);
    if (!runner?.contextCheckpoint) return plan;
    const cp = runner.contextCheckpoint;
    if (input.checkpointId && cp.checkpointId !== input.checkpointId) {
      const err = new Error('[goal-plan-store] supersedeContextCheckpoint checkpoint mismatch');
      err.code = 'GOAL_CHECKPOINT_CONFLICT';
      throw err;
    }
    const superseded = normalizeGoalCheckpoint({
      ...cp,
      status: 'superseded',
    }, {
      fallbackPlanId: plan.planId,
      fallbackRunId: runner.runId || plan.planId,
      now: nowIso,
    });
    const nextRunner = normalizeRunnerState({
      ...runner,
      status: input.runnerStatus || (runner.status === 'compacting_context' || runner.status === 'resuming_after_compaction' ? 'running' : runner.status),
      contextCheckpoint: undefined,
      updatedAt: nowIso,
    }, plan.planId);
    const nextPlan = persist({ ...plan, runner: nextRunner, updatedAt: nowIso });
    try {
      appendRunEvent(planId, {
        type: 'goal_checkpoint_superseded',
        summary: `Superseded context checkpoint ${superseded.checkpointId}`,
        payload: {
          checkpointId: superseded.checkpointId,
          sequence: superseded.sequence,
          reason: input.reason || null,
        },
      });
    } catch {
      // non-fatal
    }
    return getPlan(planId) || nextPlan;
  }

  return {
    getStoreDir: () => storeDir,
    listPlans,
    listPlansByConversation,
    countAwaitingApprovalsByConversation,
    listPlanDetails,
    listPlanDetailsByWorkspace,
    listPlanDetailsByConversation,
    getActivePlanByConversation,
    getUnacceptedCompletedPlanByConversation,
    getPlan,
    createPlan,
    createGoalContract,
    createIntakeContract,
    promoteIntakeToGoal,
    upsertGoalContract,
    revisePlan,
    recordApproval,
    setPlanStatus,
    resumeRunner,
    markRequestedUserInput,
    consumeRequestedUserInput,
    setRunnerState,
    prepareContextCheckpoint,
    commitContextCheckpoint,
    markContextCompactionPersisted,
    markContextCheckpointConsumed,
    supersedeContextCheckpoint,
    appendRunEvent,
    dispatchExplorer,
    reportExplorer,
    recordVerifierRun,
    recordEvidenceRefs,
    listEvidenceIndex: readEvidenceIndex,
    findEvidenceIndexRecords,
    recordTaskEvidence,
    cancelOpenTasks,
    recordCriterionResults,
    recordQualityReview,
    recordDeliveryHandoff,
    recordDeliveryIsolation,
    recordManualConfirmation,
    deletePlan,
    deletePlanByConversation,
    appendIntakeConvergenceAudit,
    setOnChange,
    subscribeChanges,
  };
}
