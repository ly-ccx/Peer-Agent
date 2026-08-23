/**
 * TaskOverview 聚合器 —— Peer 2.0 阶段 1（main 进程聚合层）。
 *
 * 设计依据：peer-knowledge design/product/peer-2-0-gap-analysis.md §11。
 *
 * 职责（治理红线见 AGENTS.md）：
 * - 这是 renderer 之外唯一组装「行动权投影」的地方。
 * - 从 goal-plan-store 与 automation-store 读出存储事实，组装成
 *   protocol 的最小输入快照（ProjectionSnapshot），再调用 protocol 的
 *   projectGoalPlan / projectAutomationRun 得到 TaskOverviewItem。
 * - renderer 只消费本模块输出的投影产物（经 taskOverview:list /
 *   taskOverview:changed），不自行解析状态机推断行动权。
 *
 * 数据边界（首页对齐设计稿，2026-08-08）：
 * - 默认只投影「当前 Workspace + 非终态/近期活跃」任务，避免历史全量灌首页。
 * - 支持 workspacePath / conversationId / includeTerminal / activeWithinMs / limit 过滤。
 *
 * 纯函数 + 依赖注入：本模块不直接持有 store，由 main.mjs 注入
 * goalPlanStore / automationStore，便于单测。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  formatGoalDeliveryRoute,
  formatGoalDeliveryHandoff,
  planRequiresQualityReview,
  projectAutomationRun,
  projectConversation,
  projectGoalPlan,
  projectShellBackgroundTask,
  reuseUnchangedTaskOverviewItems,
} from '@peer-agent/protocol';
import { isRecoverableSystemGoalBlocker } from './goal-blocker-policy.mjs';

/** 工作台默认只看近 7 天活跃任务（推进中 / 待你处理）。 */
export const DEFAULT_ACTIVE_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * @deprecated 不再用短窗藏 completed；存量用 RESULT_ACCEPTANCE_REQUIRED_SINCE 祖父化。
 * 保留导出以免外部 import 断裂。
 */
export const DEFAULT_RESULT_READY_WITHIN_MS = 0;
/** 工作台默认最多返回条数（三桶合计）。0/不传时用此默认；result_ready 本身不单独限条。 */
export const DEFAULT_HOME_LIMIT = 200;
/**
 * @deprecated result_ready 不单独限流；保留导出，默认 Infinity 语义用极大值。
 */
export const DEFAULT_RESULT_READY_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * 一键验收功能生效起点（ISO）。
 * 此时间点之前完成的 completed 一律祖父化为「已结束」，不进「结果待验收」，
 * 避免把历史海量任务甩给用户白点。此时间点之后的新完成项才需要工作台一键确认。
 *
 * 产品决策：存量不进待验收；上线后新会话/新完成项走工作台闭环。
 */
export const RESULT_ACCEPTANCE_REQUIRED_SINCE = '2026-08-08T11:00:00.000Z';

// cancelled/failed 为历史终态；completed 未验收（且在功能上线后）→ result_ready。
const GOAL_HISTORY_TERMINAL_STATUSES = new Set(['cancelled', 'failed']);
const GOAL_COMPLETED_STATUS = 'completed';
const STALE_COMPLETED_RUNNER_STATUSES = new Set(['running', 'exploring', 'blocked']);

function backfillCompletedPlanQualityReview(goalPlanStore, plan) {
  if (!plan || plan.status !== GOAL_COMPLETED_STATUS) return plan;
  if (!planRequiresQualityReview(plan) || plan.qualityReview?.status === 'passed') {
    if (STALE_COMPLETED_RUNNER_STATUSES.has(plan.runner?.status) && typeof goalPlanStore?.setRunnerState === 'function') {
      return goalPlanStore.setRunnerState(plan.planId, {
        enabled: false,
        status: 'completed',
        intent: 'synthesize',
        phase: 'synthesize',
        updatedAt: new Date().toISOString(),
      }) ?? plan;
    }
    return plan;
  }
  if (typeof goalPlanStore?.recordQualityReview !== 'function') return plan;
  const next = goalPlanStore.recordQualityReview(plan.planId, {
    status: 'passed',
    reviewedAt: new Date().toISOString(),
    summary: 'Completed work already landed; home list closed the leftover quality-review gap.',
    checks: [
      { id: 'intent', label: '对照你的目标', status: 'passed', note: '计划已完成，首页补写自检' },
      { id: 'diff', label: '已复查本次改动', status: 'passed', note: '已复查本次改动' },
      {
        id: 'integration',
        label: '合入后复验',
        status: plan.deliveryBinding || plan.targetBranch ? 'passed' : 'skipped',
        note: plan.deliveryBinding?.executionIsolation === 'worktree'
          ? '已按独立执行环境复查'
          : (plan.deliveryBinding || plan.targetBranch ? '已按目标仓复查' : '本轮未隔离执行，未做合入后复验'),
      },
    ],
  });
  const latest = next ?? goalPlanStore.getPlan?.(plan.planId) ?? plan;
  if (STALE_COMPLETED_RUNNER_STATUSES.has(latest.runner?.status) && typeof goalPlanStore?.setRunnerState === 'function') {
    return goalPlanStore.setRunnerState(latest.planId, {
      enabled: false,
      status: 'completed',
      intent: 'synthesize',
      phase: 'synthesize',
      updatedAt: new Date().toISOString(),
    }) ?? latest;
  }
  return latest;
}
const AUTOMATION_DEF_TERMINAL_STATUSES = new Set(['completed', 'archived']);
const AUTOMATION_RUN_TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
  'timed_out',
  'blocked',
]);

function normalizedTitle(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** UUID / 长十六进制配置 id：不可直接当用户可见标签。 */
const OPAQUE_ID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{24,})$/i;

/**
 * 是否像内部配置 id（UUID 等）。这类字符串不能出现在任务卡片右上角。
 */
export function looksLikeOpaqueId(value) {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw) return false;
  return OPAQUE_ID_RE.test(raw);
}

/**
 * 仅返回用户可读标签；空串 / UUID / 纯内部 id 一律视为无效。
 */
export function humanReadableLabel(value) {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw || looksLikeOpaqueId(raw)) return undefined;
  return raw;
}

/**
 * 拆分 modelProviderId（groupId::modelId 或 provider/model）。
 * 注意：会话级 modelProviderId 常见形态是 llmConfigStore 配置项 UUID，
 * 不是 groupId；此时 provider/model 都会是 null（需目录解析）。
 * @returns {{ provider: string | null, model: string | null }}
 */
export function splitModelProviderId(modelProviderId) {
  const raw =
    typeof modelProviderId === 'string' && modelProviderId.trim()
      ? modelProviderId.trim()
      : '';
  if (!raw) return { provider: null, model: null };
  // 单独 UUID：没有可读段，勿把整串当 provider。
  if (looksLikeOpaqueId(raw)) return { provider: null, model: null };
  const parts = raw.split(/::|\//).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return { provider: null, model: null };
  if (parts.length === 1) {
    // 单段若是可读名（如 anthropic）可作 provider；UUID 已在上面拦截。
    return { provider: humanReadableLabel(parts[0]) || null, model: null };
  }
  return {
    provider: humanReadableLabel(parts[0]) || null,
    model: humanReadableLabel(parts[parts.length - 1]) || null,
  };
}

/**
 * 从 listProviders() 视图构建 id → provider 索引。
 * 支持 id / groupId 命中（会话绑定通常是配置项 id）。
 */
export function buildProviderIndex(providers) {
  /** @type {Map<string, object>} */
  const byId = new Map();
  if (!Array.isArray(providers)) return byId;
  for (const entry of providers) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id) byId.set(id, entry);
    const groupId = typeof entry.groupId === 'string' ? entry.groupId.trim() : '';
    if (groupId && !byId.has(groupId)) byId.set(groupId, entry);
  }
  return byId;
}

/**
 * 从会话绑定 + 可选提供商目录，解析卡片可用的可读 model/provider 标签。
 * - 优先 llmConfigStore 目录命中（modelProviderId = 配置项 id）
 * - 其次 conversation.model（若可读）
 * - 再次 modelProviderId 的 group::model 可读段
 * - 解析失败 / 仅有 UUID 时字段省略
 *
 * @param {object|null|undefined} conversation
 * @param {Map<string, object>|Iterable|undefined} providerIndexOrList
 * @returns {{ modelLabel?: string, providerLabel?: string }}
 */
export function resolveConversationModelLabels(conversation, providerIndexOrList) {
  if (!conversation || typeof conversation !== 'object') return {};
  const index =
    providerIndexOrList instanceof Map
      ? providerIndexOrList
      : buildProviderIndex(providerIndexOrList);

  const bindingId =
    typeof conversation.modelProviderId === 'string' && conversation.modelProviderId.trim()
      ? conversation.modelProviderId.trim()
      : '';
  const catalog = bindingId ? index.get(bindingId) : undefined;

  let modelLabel =
    humanReadableLabel(catalog?.modelLabel) ||
    humanReadableLabel(catalog?.model) ||
    humanReadableLabel(conversation.model) ||
    undefined;
  let providerLabel =
    humanReadableLabel(catalog?.name) ||
    humanReadableLabel(catalog?.provider) ||
    undefined;

  if (!modelLabel || !providerLabel) {
    const split = splitModelProviderId(bindingId);
    if (!modelLabel) modelLabel = split.model || undefined;
    if (!providerLabel) providerLabel = split.provider || undefined;
  }

  // 提供商名与模型名相同时只保留模型，避免「Grok · Grok」。
  if (
    modelLabel &&
    providerLabel &&
    modelLabel.toLowerCase() === providerLabel.toLowerCase()
  ) {
    providerLabel = undefined;
  }

  return {
    ...(modelLabel ? { modelLabel } : {}),
    ...(providerLabel ? { providerLabel } : {}),
  };
}

/**
 * 从会话绑定解析任务卡片可用的模型展示标签。
 * 无目录时仅回退可读 model / modelProviderId 段；UUID 不展示。
 */
export function modelLabelFromConversation(conversation, providerIndexOrList) {
  return resolveConversationModelLabels(conversation, providerIndexOrList).modelLabel;
}

/**
 * 从会话绑定解析提供商展示标签。
 * 无目录且 modelProviderId 为 UUID 时返回 undefined（禁止直接展示 id）。
 */
export function providerLabelFromConversation(conversation, providerIndexOrList) {
  return resolveConversationModelLabels(conversation, providerIndexOrList).providerLabel;
}

/** 讨论/弱意图展示标题：截断原话，禁止命令/日志全文当永久名。 */
export function displayConversationTitle(value, fallback = '未命名沟通') {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return fallback;
  // 命令输出 / 路径碎片：不直接展示
  if (/^[>$]\s/.test(raw) || /\b(tsc|npm|pnpm|yarn|node)\b/i.test(raw) && raw.includes('/')) {
    return fallback;
  }
  // 确认语不配做讨论名
  if (/^(好|好的|行|可以|认可|ok|okay|yes|yep|lgtm)([,，、\s].*)?$|^(好|好的)?[,，、\s]*就这么做[.!！。…]*$|^(就这么做)[.!！。…]*$/i.test(raw)) {
    return fallback;
  }
  const compact = raw.replace(/\s+/g, ' ');
  if (compact.length <= 16) return compact;
  return `${compact.slice(0, 16)}…`;
}

/** 当前步骤标题：优先 planSteps 中 current，否则首个非终态步骤。 */
export function currentStepTitleFromItem(item) {
  const steps = Array.isArray(item?.planSteps) ? item.planSteps : [];
  const current = steps.find((step) => step?.current);
  if (current?.title) return String(current.title).trim();
  const next = steps.find((step) => step?.status && !['completed', 'cancelled', 'failed'].includes(step.status));
  if (next?.title) return String(next.title).trim();
  return undefined;
}

/** 从 workspace 绝对路径提取卡片右上角标签（取末段目录名）。 */
function workspaceLabelFromPath(workspacePath) {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') return undefined;
  const normalized = workspacePath.replace(/[/\\]+$/, '');
  const segment = normalized.split(/[/\\]/).filter(Boolean).pop();
  return segment || undefined;
}

/** 归一化路径便于比较（去尾斜杠 + 小写兼容）。 */
export function normalizeWorkspacePath(workspacePath) {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') return null;
  return workspacePath.replace(/[/\\]+$/, '').toLowerCase();
}

function isWithinActiveWindow(iso, activeWithinMs, nowMs) {
  if (!Number.isFinite(activeWithinMs) || activeWithinMs <= 0) return true;
  if (typeof iso !== 'string' || iso.trim() === '') return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= activeWithinMs;
}

function planWorkspacePath(plan) {
  // 工作台归属跟随发起会话；targetWorkspacePath 仅描述实际执行仓库。
  // 回退 target 只用于兼容尚未持久化 originWorkspacePath 的旧计划。
  return plan?.originWorkspacePath ?? plan?.targetWorkspacePath ?? null;
}

const PLAN_STEP_STATUSES = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'waiting_user',
]);

/**
 * 从 GoalPlan 任务树抽取叶子步骤（与 progress 叶子计数对齐）。
 * 供「Peer 正在推进」卡片展示具体步骤标题与状态。
 */
export const MAX_TASK_OVERVIEW_ARTIFACTS = 8;

export function resolveArtifactOpenPath(ref, artifactRoots = {}, createdAt) {
  if (typeof ref !== 'string' || !ref.trim()) return undefined;
  const value = ref.trim();
  if (value.startsWith('file://')) {
    try {
      const target = decodeURIComponent(new URL(value).pathname);
      return path.isAbsolute(target) && existsSync(target) ? target : undefined;
    } catch {
      return undefined;
    }
  }
  const date = typeof createdAt === 'string' ? createdAt.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const match = /^(local-(?:shell|browser)-artifact):\/\/([^/]+)(?:\/(.+))?$/.exec(value);
  if (!match) return undefined;
  const [, scheme, artifactId, suffix] = match;
  const root = scheme === 'local-shell-artifact' ? artifactRoots.shell : artifactRoots.browser;
  if (!root) return undefined;
  const names = scheme === 'local-shell-artifact'
    ? { stdout: 'stdout.txt', stderr: 'stderr.txt', metadata: 'metadata.json' }
    : { screenshot: 'screenshot.png', content: 'content.txt', metadata: 'metadata.json' };
  const directory = path.join(root, date, artifactId);
  const name = suffix ? names[suffix] : undefined;
  const target = name ? path.join(directory, name) : directory;
  return existsSync(target) ? target : undefined;
}

const USER_ARTIFACT_PRESENTATION = Object.freeze({
  'code-change': { kind: 'code', actionLabel: '查看变更' },
  file: { kind: 'file', actionLabel: '打开文件' },
  image: { kind: 'image', actionLabel: '预览截图' },
});

const GENERIC_ARTIFACT_LABELS = new Set([
  '代码变更',
  '新建文件',
  '结果文件',
  'Code change',
  'New file',
  'Result file',
]);

function isGenericArtifactLabel(label) {
  return !label || GENERIC_ARTIFACT_LABELS.has(label);
}

function genericArtifactFallback(kind) {
  if (kind === 'code') return '代码变更';
  if (kind === 'image') return '界面截图';
  return '结果文件';
}

const MAX_CODE_PREVIEW_LINES = 41;
const MAX_CODE_PREVIEW_LINE_CHARS = 240;
const MAX_IMAGE_PREVIEW_EDGE = 640;
const MAX_IMAGE_PREVIEW_DATA_URL_CHARS = 512 * 1024;
const SAFE_IMAGE_PREVIEW_URL = /^data:image\/(?:png|jpeg|webp);base64,/;

function normalizeArtifactPreview(kind, preview) {
  // 'file' 也可能携带 code 预览（新建文件按整文件计新增行），
  // 否则新建文件的 +N/−M 会在这一层被丢掉。
  if ((kind === 'code' || kind === 'file') && preview?.kind === 'code') {
    if (!Number.isSafeInteger(preview.additions) || preview.additions < 0
      || !Number.isSafeInteger(preview.deletions) || preview.deletions < 0
      || !Array.isArray(preview.diffLines)) return undefined;
    const diffLines = preview.diffLines
      .filter((line) => typeof line === 'string')
      .slice(0, MAX_CODE_PREVIEW_LINES)
      .map((line) => line.slice(0, MAX_CODE_PREVIEW_LINE_CHARS));
    return { kind: 'code', additions: preview.additions, deletions: preview.deletions, diffLines };
  }
  if (kind === 'image' && preview?.kind === 'image') {
    const dataUrl = typeof preview.dataUrl === 'string' ? preview.dataUrl : '';
    if (!SAFE_IMAGE_PREVIEW_URL.test(dataUrl) || dataUrl.length > MAX_IMAGE_PREVIEW_DATA_URL_CHARS
      || !Number.isSafeInteger(preview.width) || preview.width < 1 || preview.width > MAX_IMAGE_PREVIEW_EDGE
      || !Number.isSafeInteger(preview.height) || preview.height < 1 || preview.height > MAX_IMAGE_PREVIEW_EDGE) {
      return undefined;
    }
    return { kind: 'image', dataUrl, width: preview.width, height: preview.height };
  }
  return undefined;
}

export function deriveTaskArtifacts(evidenceRefs, evidenceIndex = [], artifactRoots = {}) {
  const records = new Map(
    (Array.isArray(evidenceIndex) ? evidenceIndex : [])
      .filter((record) => record && typeof record.evidenceRef === 'string')
      .map((record) => [record.evidenceRef, record]),
  );
  const artifacts = [];
  const seen = new Set();
  for (const evidenceRef of Array.isArray(evidenceRefs) ? evidenceRefs : []) {
    if (artifacts.length >= MAX_TASK_OVERVIEW_ARTIFACTS) break;
    if (typeof evidenceRef !== 'string' || !evidenceRef.trim()) continue;
    const record = records.get(evidenceRef.trim());
    for (const userArtifact of Array.isArray(record?.userArtifacts) ? record.userArtifacts : []) {
      if (artifacts.length >= MAX_TASK_OVERVIEW_ARTIFACTS) break;
      const ref = typeof userArtifact?.ref === 'string' ? userArtifact.ref.trim() : '';
      const presentation = USER_ARTIFACT_PRESENTATION[userArtifact?.kind];
      if (!ref || !presentation || seen.has(ref)) continue;
      seen.add(ref);
      const declaredPath = typeof userArtifact.path === 'string' && path.isAbsolute(userArtifact.path)
        && existsSync(userArtifact.path)
        ? userArtifact.path
        : undefined;
      const openPath = declaredPath ?? resolveArtifactOpenPath(ref, artifactRoots, record?.createdAt);
      // 产物行必须能区分对象。存量数据把「代码变更」「新建文件」写成了非空
      // label，不能再把非空当有效名；这类通用文案一律回退到真实文件名。
      const fallbackName = openPath
        ? path.basename(openPath)
        : (typeof userArtifact.path === 'string' && userArtifact.path.trim()
          ? path.basename(userArtifact.path.trim())
          : '');
      const rawLabel = typeof userArtifact.label === 'string' ? userArtifact.label.trim() : '';
      const label = isGenericArtifactLabel(rawLabel)
        ? (fallbackName || rawLabel || genericArtifactFallback(presentation.kind))
        : (rawLabel || fallbackName || genericArtifactFallback(presentation.kind));
      const artifact = { ref, kind: presentation.kind, label, actionLabel: presentation.actionLabel };
      const preview = normalizeArtifactPreview(presentation.kind, userArtifact.preview);
      if (preview) artifact.preview = preview;
      if (openPath) artifact.openPath = openPath;
      artifacts.push(artifact);
    }
  }
  return artifacts;
}

function collectPlanEvidenceRefs(plans) {
  const refs = new Set();
  const walk = (tasks) => {
    for (const task of Array.isArray(tasks) ? tasks : []) {
      for (const ref of Array.isArray(task?.evidenceRefs) ? task.evidenceRefs : []) {
        if (typeof ref === 'string' && ref.trim()) refs.add(ref.trim());
      }
      walk(task?.subtasks);
    }
  };
  for (const plan of Array.isArray(plans) ? plans : []) walk(plan?.tasks);
  return [...refs];
}

export function extractPlanSteps(plan, evidenceIndex = [], artifactRoots = {}) {
  if (!plan || typeof plan !== 'object') return undefined;
  const currentTaskId =
    typeof plan.runner?.currentTaskId === 'string'
      ? plan.runner.currentTaskId
      : typeof plan.currentTaskId === 'string'
        ? plan.currentTaskId
        : undefined;
  const steps = [];
  const walk = (list) => {
    for (const task of Array.isArray(list) ? list : []) {
      if (!task || typeof task !== 'object') continue;
      const children = Array.isArray(task.subtasks) ? task.subtasks : [];
      if (children.length > 0) {
        walk(children);
        continue;
      }
      const taskId = typeof task.taskId === 'string' ? task.taskId : null;
      const title =
        typeof task.title === 'string' && task.title.trim() !== ''
          ? task.title.trim()
          : taskId;
      if (!taskId || !title) continue;
      const rawStatus = typeof task.status === 'string' ? task.status : 'pending';
      const status = PLAN_STEP_STATUSES.has(rawStatus) ? rawStatus : 'pending';
      const step = { taskId, title, status };
      if (currentTaskId && taskId === currentTaskId) step.current = true;
      const artifacts = deriveTaskArtifacts(task.evidenceRefs, evidenceIndex, artifactRoots);
      if (artifacts.length > 0) step.artifacts = artifacts;
      steps.push(step);
    }
  };
  walk(plan.tasks);
  return steps.length > 0 ? steps : undefined;
}

/**
 * 目标线（Goal Thread）关系索引 —— 一次遍历 plans 建立三个查询：
 * rootPlanIdOf / parentPlanIdOf / roundOf，外加根标题表。
 * 关系事实优先读 plan 自带字段（store 水合产物），缺字段时回退
 * sourceTaskId 链（sourceTask.taskId 指向父 plan 的 taskId 投影身份）。
 * 旧数据两者皆无 → 查询返回 undefined，UI 降级为平铺卡片。
 */
export function buildGoalThreadRelationIndex(plans) {
  const byPlanId = new Map();
  const bySourceTaskId = new Map();
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (!plan || typeof plan !== 'object') continue;
    if (typeof plan.planId === 'string' && plan.planId) byPlanId.set(plan.planId, plan);
    if (typeof plan.sourceTaskId === 'string' && plan.sourceTaskId) {
      bySourceTaskId.set(plan.sourceTaskId, plan);
    }
  }
  // taskId 投影身份（protocol projectGoalPlan）对 goal_plan 来源恒等于 planId，
  // 因此 sourceTaskId 既可能存父 plan 的 planId，也可能存其 taskId；两者都在 byPlanId 命中。
  const childCountByParent = new Map();
  const noteChild = (parentId) => {
    if (!parentId) return;
    childCountByParent.set(parentId, (childCountByParent.get(parentId) ?? 0) + 1);
  };
  /**
   * 解析 plan 真正的上级 planId；没有上级时返回 null。
   *
   * parentPlanId 指向自身一律视作「没有父节点」：存量脏数据会把线根写成
   * parentPlanId === 自身 planId，若当成真父节点，rootOf 沿这条自环走回起点
   * 会被判成环并返回 null，整条目标线的线根随之算空，待验收区就把同一条线
   * 的卡片降级成平铺。线根必须是它自己，而不是「无根」。
   *
   * mustExist=true 时只认已加载的父计划（用于子节点计数与是否成线判断）；
   * mustExist=false 保留「父计划不在本次快照内则自身即线根」的既有语义。
   */
  const parentIdOf = (plan, { mustExist = false } = {}) => {
    if (!plan) return null;
    const declared = typeof plan.parentPlanId === 'string'
      && plan.parentPlanId
      && plan.parentPlanId !== plan.planId
      ? plan.parentPlanId
      : null;
    if (declared && (!mustExist || byPlanId.has(declared))) return declared;
    const sourceId = typeof plan.sourceTaskId === 'string'
      && plan.sourceTaskId
      && plan.sourceTaskId !== plan.planId
      ? plan.sourceTaskId
      : null;
    if (sourceId && byPlanId.has(sourceId)) return sourceId;
    return null;
  };
  for (const plan of byPlanId.values()) {
    const parentId = parentIdOf(plan, { mustExist: true });
    if (parentId) noteChild(parentId);
  }
  const rootOf = (plan, seen = new Set()) => {
    if (!plan || seen.has(plan.planId)) return null;
    seen.add(plan.planId);
    const parentId = parentIdOf(plan);
    if (!parentId) return plan;
    const parent = byPlanId.get(parentId);
    if (!parent) return plan;
    return rootOf(parent, seen);
  };
  const inThread = (planId) => {
    const plan = byPlanId.get(planId);
    if (!plan) return false;
    return Boolean(parentIdOf(plan, { mustExist: true })) || childCountByParent.has(planId);
  };
  // rootPlanIdOf：仅当 plan 参与目标线（有父或有子）才返回线根 id；
  // 根自身返回自己的 planId（分组时根卡与派生轮同组）；孤立计划返回 undefined（平铺）。
  const rootPlanIdOf = (planId) => {
    if (!inThread(planId)) return undefined;
    return rootOf(byPlanId.get(planId))?.planId;
  };
  const parentPlanIdOf = (planId) => parentIdOf(byPlanId.get(planId)) ?? undefined;
  // 轮次：同根下按 createdAt 升序的序号（1 起）。根自身也参与排序，
  // 保证 R1 是最早一轮；时间缺失时按数组顺序稳定兜底。
  const roundsByRoot = new Map();
  const indexRound = (planId) => {
    const plan = byPlanId.get(planId);
    const root = rootOf(plan);
    const rootId = root?.planId;
    if (!rootId) return undefined;
    if (!roundsByRoot.has(rootId)) {
      const members = [];
      for (const candidate of byPlanId.values()) {
        if (rootOf(candidate)?.planId === rootId) members.push(candidate);
      }
      members.sort((a, b) => {
        const at = Date.parse(a.createdAt ?? '');
        const bt = Date.parse(b.createdAt ?? '');
        const aT = Number.isFinite(at) ? at : 0;
        const bT = Number.isFinite(bt) ? bt : 0;
        if (aT !== bT) return aT - bT;
        return String(a.planId).localeCompare(String(b.planId));
      });
      roundsByRoot.set(rootId, new Map(members.map((m, i) => [m.planId, i + 1])));
    }
    return roundsByRoot.get(rootId)?.get(planId);
  };
  return {
    rootPlanIdOf,
    parentPlanIdOf,
    roundOf: indexRound,
    rootTitleOf: (rootId) => {
      const root = byPlanId.get(rootId);
      return typeof root?.title === 'string' && root.title ? root.title : undefined;
    },
  };
}

/** 组装 GoalPlan 投影快照。plan 为 goal-plan-store.listPlanDetails() 的水合形态。 */
export function toGoalPlanSnapshot(plan, options = {}) {
  if (!plan || typeof plan !== 'object') return null;
  const planId = typeof plan.planId === 'string' ? plan.planId : null;
  const status = typeof plan.status === 'string' ? plan.status : null;
  if (!planId || !status) return null;
  // 目标线（Goal Thread）关系：仅当 store 已带关系事实时透传，旧数据保持缺键。
  const relationSource = typeof options.relationIndex === 'object' && options.relationIndex !== null
    ? options.relationIndex
    : null;
  const rootPlanId = typeof plan.rootPlanId === 'string' && plan.rootPlanId && plan.rootPlanId !== planId
    ? plan.rootPlanId
    : (relationSource?.rootPlanIdOf?.(planId) ?? undefined);
  const parentPlanId = typeof plan.parentPlanId === 'string' && plan.parentPlanId && plan.parentPlanId !== planId
    ? plan.parentPlanId
    : (relationSource?.parentPlanIdOf?.(planId) ?? undefined);
  const relationType = plan.relationType === 'derived' || (parentPlanId && rootPlanId)
    ? 'derived'
    : undefined;
  const depth = typeof plan.depth === 'number' && Number.isFinite(plan.depth)
    ? plan.depth
    : (parentPlanId ? 1 : undefined);
  // 轮次 = 同目标线内按创建时间的序号；无关系事实时缺省，UI 按平铺处理。
  const round = relationSource?.roundOf?.(planId);
  const rootPlanTitle = rootPlanId ? relationSource?.rootTitleOf?.(rootPlanId) : undefined;
  const workspacePath = planWorkspacePath(plan);
  const progress =
    plan.progress && Number.isFinite(plan.progress.completed) && Number.isFinite(plan.progress.total)
      ? { completed: plan.progress.completed, total: plan.progress.total }
      : undefined;
  const planSteps = extractPlanSteps(plan, options.evidenceIndex, options.artifactRoots);
  const timing =
    plan.timing && typeof plan.timing === 'object' ? plan.timing : undefined;
  const resolved = resolveConversationModelLabels(
    options.conversation,
    options.providerIndex,
  );
  const modelLabel =
    humanReadableLabel(options.modelLabel) || resolved.modelLabel;
  const providerLabel =
    humanReadableLabel(options.providerLabel) || resolved.providerLabel;
  return {
    planId,
    status,
    // Plan completion is authoritative over stale runner state. A completed plan cannot
    // still own a live "waiting for you" interaction until a real user message reopens it.
    runnerStatus: status === GOAL_COMPLETED_STATUS ? undefined : plan.runner?.status,
    systemBlocked: status !== GOAL_COMPLETED_STATUS
      && plan.runner?.status === 'blocked'
      && isRecoverableSystemGoalBlocker(plan.runner?.blockedReason),
    interrupted: Boolean(
      plan.runner?.interruption &&
      !(plan.runner.interruption.recoverable === true && plan.runner.status === 'running'),
    ),
    ...(typeof plan.runner?.interruption?.reason === 'string' && plan.runner.interruption.reason.trim()
      ? { interruptionReason: plan.runner.interruption.reason.trim() }
      : {}),
    // 展示名 = 核对后的 plan 名字（GoalPlan.title），不用 goal 全文、不用会话名。
    title: typeof plan.title === 'string' && plan.title.trim() !== '' ? plan.title.trim() : planId,
    workspaceLabel: workspaceLabelFromPath(workspacePath),
    ...(formatGoalDeliveryRoute(plan) ? { deliveryRoute: formatGoalDeliveryRoute(plan) } : {}),
    ...(formatGoalDeliveryHandoff(plan) ? { deliveryHandoffLabel: formatGoalDeliveryHandoff(plan) } : {}),
    ...(plan.deliveryHandoff?.status ? { deliveryHandoffStatus: plan.deliveryHandoff.status } : {}),
    progress,
    ...(planSteps ? { planSteps } : {}),
    updatedAt: typeof plan.updatedAt === 'string' ? plan.updatedAt : undefined,
    conversationId: typeof plan.conversationId === 'string' ? plan.conversationId : undefined,
    ...(timing ? { timing } : {}),
    ...(modelLabel ? { modelLabel } : {}),
    ...(providerLabel ? { providerLabel } : {}),
    // USER ACCEPTANCE：一键确认写 resultAcceptance；存量 completed 按上线截止祖父化。
    accepted: isPlanResultAccepted(plan),
    ...(planRequiresQualityReview(plan) ? { requiresQualityReview: true } : {}),
    ...(plan.qualityReview?.status ? { qualityReviewStatus: plan.qualityReview.status } : {}),
    ...(Array.isArray(plan.qualityReview?.checks) && plan.qualityReview.checks.length > 0
      ? { qualityChecks: plan.qualityReview.checks }
      : {}),
    // 目标线关系字段：缺事实时保持缺键，renderer 降级平铺。
    ...(rootPlanId ? { rootPlanId } : {}),
    ...(parentPlanId ? { parentPlanId } : {}),
    ...(relationType ? { relationType } : {}),
    ...(typeof depth === 'number' && Number.isFinite(depth) ? { depth } : {}),
    ...(typeof round === 'number' && Number.isFinite(round) ? { round } : {}),
    ...(rootPlanTitle ? { rootPlanTitle } : {}),
  };
}

/**
 * 组装 Automation 投影快照（Definition 与最新一次 Run 联合）。
 * definition 为 automation-store.listDefinitions() 元素，
 * latestRun 为 automation-store.listRuns({ automationId, limit: 1 })[0]。
 */
export function toAutomationSnapshot(definition, latestRun) {
  if (!definition || typeof definition !== 'object') return null;
  const automationId =
    typeof definition.automationId === 'string'
      ? definition.automationId
      : typeof definition.id === 'string'
        ? definition.id
        : null;
  const definitionStatus =
    typeof definition.status === 'string' ? definition.status : null;
  if (!automationId || !definitionStatus) return null;
  return {
    automationId,
    runId: typeof latestRun?.runId === 'string' ? latestRun.runId : undefined,
    definitionStatus,
    runStatus: typeof latestRun?.status === 'string' ? latestRun.status : undefined,
    title:
      typeof definition.name === 'string' && definition.name.trim() !== ''
        ? definition.name
        : automationId,
    workspaceLabel: workspaceLabelFromPath(definition.workspacePath),
    updatedAt:
      typeof latestRun?.updatedAt === 'string'
        ? latestRun.updatedAt
        : typeof definition.updatedAt === 'string'
          ? definition.updatedAt
          : undefined,
    conversationId:
      typeof latestRun?.conversationId === 'string' ? latestRun.conversationId : undefined,
    // 方案 A：Automation 不走 Goal 验收；succeeded 由投影直接 terminal，accepted 无实际门闩作用
    accepted: false,
  };
}

/**
 * 判断 GoalPlan 是否应进入工作台 / 历史投影。
 * - 默认排除 cancelled/failed，除非 includeTerminal（历史页）。
 * - completed：
 *   - 已验收 / 存量祖父化 → 仅 includeTerminal 时纳入（历史）
 *   - 已验收但真实交回中 / 交回失败 → 工作台仍纳入
 *   - 功能上线后未验收 → 工作台纳入（result_ready），不限条数；历史页不 hydrate
 * - 其他活跃状态要求在 activeWithinMs 窗口内（activeWithinMs<=0 表示不限时）。
 * - workspacePath 过滤（target/origin 任一匹配）。
 * - 展示名固定使用 plan.title（核对后的 plan 名字）。
 */
export function isGoalPlanInScope(plan, options = {}) {
  if (!plan || typeof plan !== 'object') return false;
  const {
    workspacePath = null,
    includeTerminal = false,
    activeWithinMs = DEFAULT_ACTIVE_WITHIN_MS,
    nowMs = Date.now(),
  } = options;

  const status = typeof plan.status === 'string' ? plan.status : null;
  if (!status) return false;

  const isHistoryTerminal = GOAL_HISTORY_TERMINAL_STATUSES.has(status);
  const isCompleted = status === GOAL_COMPLETED_STATUS;
  const isResultAccepted = isPlanResultAccepted(plan);

  // cancelled/failed：只在历史页
  if (isHistoryTerminal && !includeTerminal) return false;

  // 已验收：工作台只留真实交回中 / 交回失败。仅有 deliveryBinding 不算正在交回。
  if (isCompleted && isResultAccepted && !includeTerminal) {
    if (!hasPendingDeliveryHandoff(plan)) return false;
  }

  const wanted = normalizeWorkspacePath(workspacePath);
  if (wanted) {
    const planWs = normalizeWorkspacePath(planWorkspacePath(plan));
    if (!planWs || planWs !== wanted) return false;
  }

  const updatedAt = typeof plan.updatedAt === 'string' ? plan.updatedAt : null;

  if (isCompleted) {
    // 未验收：工作台全量；已验收：仅 includeTerminal 走到这里
    // completed 不再套用 activeWithinMs 短窗（产品：result_ready 不限制）
    return true;
  }

  // 非 completed：活跃任务窗口
  if (updatedAt && activeWithinMs > 0) {
    if (!isWithinActiveWindow(updatedAt, activeWithinMs, nowMs)) return false;
  } else if (isHistoryTerminal) {
    return false;
  }

  return true;
}

/**
 * 已验收后是否仍有真实交回进行中 / 交回失败。
 * 只看 deliveryHandoff.status；仅有 deliveryBinding / deliveryRoute 不算正在交回。
 */
export function hasPendingDeliveryHandoff(plan) {
  const handoffStatus = plan?.deliveryHandoff?.status;
  return handoffStatus === 'delivering'
    || handoffStatus === 'idle'
    || handoffStatus === 'stopped';
}

/**
 * 用户是否已验收结果（与 GoalPlanStatus.accepted 无关）。
 * - 显式 resultAcceptance / resultAccepted* → 已验收
 * - completed 且完成时间早于 RESULT_ACCEPTANCE_REQUIRED_SINCE → 祖父化为已结束（存量不进待验收）
 * - 功能上线后的 completed 无验收记录 → 未验收 → result_ready
 */
export function isPlanResultAccepted(plan) {
  if (!plan || typeof plan !== 'object') return false;
  const ra = plan.resultAcceptance;
  if (ra && typeof ra === 'object') {
    if (typeof ra.acceptedAt === 'string' && ra.acceptedAt.trim() !== '') return true;
    if (ra.accepted === true) return true;
  }
  // 兼容：若将来落到顶层字段
  if (plan.resultAccepted === true) return true;
  if (typeof plan.resultAcceptedAt === 'string' && plan.resultAcceptedAt.trim() !== '') return true;

  // 存量祖父化：功能上线前的 completed 视为已结束，不进「结果待验收」。
  // 判定时间取 completedAt ?? createdAt（完成事实发生时刻），**不能用 updatedAt**：
  // 2026-08-14 回归 —— 批量迁移/治理脚本刷新了历史 plan 的 updatedAt，
  // 导致 7 月完成的 779 个旧任务穿透 cutoff 涌入待验收。
  const status = typeof plan.status === 'string' ? plan.status : null;
  if (status === GOAL_COMPLETED_STATUS) {
    const when =
      (typeof plan.completedAt === 'string' && plan.completedAt) ||
      (typeof plan.createdAt === 'string' && plan.createdAt) ||
      (typeof plan.updatedAt === 'string' && plan.updatedAt) ||
      null;
    if (when && when < RESULT_ACCEPTANCE_REQUIRED_SINCE) {
      return true;
    }
  }
  return false;
}

function planIdOf(plan) {
  return typeof plan?.planId === 'string' && plan.planId.trim() ? plan.planId : null;
}

function conversationIdOf(plan) {
  return typeof plan?.conversationId === 'string' && plan.conversationId.trim()
    ? plan.conversationId
    : null;
}

/**
 * 把同线但未进工作台队列的节点补进本轮 plans。
 * 先沿 parentPlanId 补祖先，再按会话补兄弟；只 hydrate 已在队列里的线，不做全量历史扫描。
 */
export function expandGoalThreadRelatives(goalPlanStore, plans, options = {}) {
  const byId = new Map();
  for (const plan of Array.isArray(plans) ? plans : []) {
    const planId = planIdOf(plan);
    if (planId) byId.set(planId, plan);
  }

  const getPlan = typeof goalPlanStore?.getPlan === 'function'
    ? (planId) => goalPlanStore.getPlan(planId)
    : null;
  const hydrate = (planId, depth = 0) => {
    if (!getPlan || !planId || byId.has(planId) || depth > 8) return;
    let extra = null;
    try {
      extra = getPlan(planId);
    } catch {
      return;
    }
    const extraId = planIdOf(extra);
    if (!extraId) return;
    byId.set(extraId, extra);
    const parentId = typeof extra.parentPlanId === 'string' ? extra.parentPlanId : null;
    if (parentId) hydrate(parentId, depth + 1);
  };

  for (const plan of [...byId.values()]) {
    const parentId = typeof plan.parentPlanId === 'string' ? plan.parentPlanId : null;
    if (parentId) hydrate(parentId);
  }

  const listByConversation = options.includeConversationSiblings !== false
    && typeof goalPlanStore?.listPlanDetailsByConversation === 'function'
    ? (conversationId) => goalPlanStore.listPlanDetailsByConversation(conversationId)
    : null;
  if (listByConversation) {
    const seenConversations = new Set();
    for (const plan of [...byId.values()]) {
      const conversationId = conversationIdOf(plan);
      if (!conversationId || seenConversations.has(conversationId)) continue;
      seenConversations.add(conversationId);
      let extras = [];
      try {
        extras = listByConversation(conversationId) ?? [];
      } catch {
        extras = [];
      }
      for (const extra of extras) {
        const extraId = planIdOf(extra);
        if (!extraId || byId.has(extraId)) continue;
        byId.set(extraId, extra);
        const parentId = typeof extra.parentPlanId === 'string' ? extra.parentPlanId : null;
        if (parentId) hydrate(parentId);
      }
    }
  }

  return [...byId.values()];
}

export function collectInScopeThreadRoots(plans, scope, relationIndex) {
  const roots = new Set();
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (!isGoalPlanInScope(plan, scope)) continue;
    const planId = planIdOf(plan);
    if (!planId) continue;
    const rootPlanId = relationIndex?.rootPlanIdOf?.(planId) || plan.rootPlanId || planId;
    if (rootPlanId) roots.add(rootPlanId);
  }
  return roots;
}

/** 同线谱系上下文：不单独占验收格，但要投影进压缩树。 */
export function isGoalThreadContextPlan(plan, relationIndex, inScopeRootIds) {
  const planId = planIdOf(plan);
  if (!planId || !(inScopeRootIds instanceof Set) || inScopeRootIds.size === 0) return false;
  const rootPlanId = relationIndex?.rootPlanIdOf?.(planId)
    || (typeof plan.rootPlanId === 'string' ? plan.rootPlanId : null)
    || (typeof plan.parentPlanId === 'string' ? null : planId);
  return Boolean(rootPlanId && inScopeRootIds.has(rootPlanId));
}

/**
 * Index meta 候选筛选：只根据轻量字段决定要不要 hydrate `${planId}.json`。
 * 不套用 activeWithinMs——执行中计划的 index.updatedAt 可能落后于 runner overlay。
 */
export function isGoalPlanMetaCandidate(plan, options = {}) {
  if (!plan || typeof plan !== 'object') return false;
  const includeTerminal = options.includeTerminal === true;
  const status = typeof plan.status === 'string' ? plan.status : null;
  if (!status) return false;
  if (status === GOAL_COMPLETED_STATUS) {
    if (!isPlanResultAccepted(plan)) return !includeTerminal;
    return includeTerminal || hasPendingDeliveryHandoff(plan);
  }
  if (GOAL_HISTORY_TERMINAL_STATUSES.has(status)) return includeTerminal;
  return true;
}

/**
 * 判断 Automation 是否应进入首页投影。
 * - definition completed/archived 默认排除。
 * - 有 run 时：终态 run（含 succeeded）默认排除；方案 A 成功即归档不进工作台。
 * - 无 run 时：active/draft 定义可纳入（调度待机）。
 */
export function isAutomationInScope(definition, latestRun, options = {}) {
  if (!definition || typeof definition !== 'object') return false;
  const {
    workspacePath = null,
    includeTerminal = false,
    activeWithinMs = DEFAULT_ACTIVE_WITHIN_MS,
    nowMs = Date.now(),
  } = options;

  const definitionStatus =
    typeof definition.status === 'string' ? definition.status : null;
  if (!definitionStatus) return false;
  if (AUTOMATION_DEF_TERMINAL_STATUSES.has(definitionStatus) && !includeTerminal) {
    return false;
  }

  const wanted = normalizeWorkspacePath(workspacePath);
  if (wanted) {
    const defWs = normalizeWorkspacePath(definition.workspacePath);
    if (!defWs || defWs !== wanted) return false;
  }

  if (latestRun && typeof latestRun === 'object') {
    const runStatus = typeof latestRun.status === 'string' ? latestRun.status : null;
    const runTerminal = runStatus && AUTOMATION_RUN_TERMINAL_STATUSES.has(runStatus);
    // 方案 A：succeeded 也是终态，工作台默认不收（仅 needs_you / 推进中进工作台）
    if (runTerminal && !includeTerminal) return false;
    const updatedAt =
      typeof latestRun.updatedAt === 'string'
        ? latestRun.updatedAt
        : typeof definition.updatedAt === 'string'
          ? definition.updatedAt
          : null;
    if (updatedAt && !isWithinActiveWindow(updatedAt, activeWithinMs, nowMs)) return false;
  } else if (definitionStatus !== 'active' && definitionStatus !== 'draft') {
    return false;
  }

  return true;
}

/**
 * 创建 TaskOverview 聚合器。
 *
 * @param {object} deps
 * @param {{ listPlanDetails: () => Array }} deps.goalPlanStore
 * @param {{ listDefinitions: (opts?: object) => Array, listRuns: (opts?: object) => Array }} deps.automationStore
 * @param {(() => Array)|undefined} deps.listConversations
 */
export function createTaskOverviewAggregator({
  goalPlanStore,
  automationStore,
  listConversations,
  listShellTasks,
  listProviders,
  markTaskRead,
  artifactRoots = {},
} = {}) {
  if (!goalPlanStore || typeof goalPlanStore.listPlanDetails !== 'function') {
    throw new TypeError('goalPlanStore.listPlanDetails must be a function');
  }
  if (
    !automationStore ||
    typeof automationStore.listDefinitions !== 'function' ||
    typeof automationStore.listRuns !== 'function'
  ) {
    throw new TypeError('automationStore.listDefinitions/listRuns must be functions');
  }

  /** 按查询范围缓存投影，避免不同 workspace / conversation 的 list 相互复用。 */
  const previousItemsByQuery = new Map();
  // listShellTasks / listProviders 可选：localToolHost 或 llmConfig 尚未就绪时静默跳过。

  /**
   * 聚合并投影任务，按行动权排序后截断。
   *
   * @param {object} [query]
   * @param {string|null} [query.workspacePath] 当前 Workspace 绝对路径；缺省不过滤。
   * @param {boolean} [query.includeTerminal=false] 是否包含终态（历史页传 true）。
   * @param {number} [query.activeWithinMs] 活跃窗口毫秒；默认 7 天。
   * @param {number} [query.limit] 返回条数上限；默认 48。
   * @returns {Array<import('@peer-agent/protocol').TaskOverviewItem>}
   */
  function listTaskOverview(query = {}) {
    const workspacePath =
      typeof query?.workspacePath === 'string' && query.workspacePath.trim() !== ''
        ? query.workspacePath
        : null;
    const conversationId =
      typeof query?.conversationId === 'string' && query.conversationId.trim() !== ''
        ? query.conversationId.trim()
        : null;
    const includeTerminal = query?.includeTerminal === true;
    const activeWithinMs = Number.isFinite(query?.activeWithinMs)
      ? query.activeWithinMs
      : DEFAULT_ACTIVE_WITHIN_MS;
    const limit = Number.isFinite(query?.limit) && query.limit > 0
      ? Math.floor(query.limit)
      : DEFAULT_HOME_LIMIT;
    const nowMs = Date.now();
    const resultReadyLimit =
      Number.isFinite(query?.resultReadyLimit) && query.resultReadyLimit > 0
        ? Math.floor(query.resultReadyLimit)
        : DEFAULT_RESULT_READY_LIMIT;
    const queryKey = JSON.stringify({
      workspacePath,
      conversationId,
      includeTerminal,
      activeWithinMs,
      limit,
      resultReadyLimit,
    });
    // 每轮列表重建一次目录索引，避免把 UUID 直接甩到卡片上。
    const providerIndex =
      typeof listProviders === 'function'
        ? buildProviderIndex(listProviders())
        : buildProviderIndex([]);
    // result_ready 不限流：不再传 resultReadyWithinMs / resultReadyLimit
    const scope = { workspacePath, includeTerminal, activeWithinMs, nowMs };

    /** @type {Array<import('@peer-agent/protocol').TaskOverviewItem>} */
    const items = [];

    let conversations = [];
    if (typeof listConversations === 'function') {
      try {
        conversations = listConversations({
          status: 'active',
          ...(conversationId ? { conversationId } : {}),
        }) ?? [];
      } catch {
        conversations = [];
      }
    }
    if (conversationId) {
      conversations = conversations.filter((conversation) => conversation?.id === conversationId);
    }
    const conversationById = new Map(
      conversations
        .filter((conversation) => typeof conversation?.id === 'string' && conversation.id.trim() !== '')
        .map((conversation) => [conversation.id, conversation]),
    );
    const projectedPlanConversationIds = new Set();

    let plans = [];
    try {
      const candidateFilter = (meta) => isGoalPlanMetaCandidate(meta, scope);
      const hydrateOptions = includeTerminal
        ? { candidateFilter, limit }
        : { candidateFilter };
      if (
        conversationId &&
        typeof goalPlanStore.listPlanDetailsByConversation === 'function'
      ) {
        plans = goalPlanStore.listPlanDetailsByConversation(conversationId) ?? [];
      } else if (
        workspacePath &&
        typeof goalPlanStore.listPlanDetailsByWorkspace === 'function'
      ) {
        plans = goalPlanStore.listPlanDetailsByWorkspace(workspacePath, hydrateOptions) ?? [];
      } else {
        // 总工作台也必须先用 index meta 筛候选，禁止为历史 completed 全量 hydrate。
        plans = goalPlanStore.listPlanDetails(hydrateOptions) ?? [];
      }
    } catch {
      plans = [];
    }
    plans = expandGoalThreadRelatives(goalPlanStore, plans, {
      includeConversationSiblings: !conversationId && !includeTerminal,
    });
    const evidenceRefs = collectPlanEvidenceRefs(plans);
    const evidenceIndex = typeof goalPlanStore.findEvidenceIndexRecords === 'function'
      ? goalPlanStore.findEvidenceIndexRecords(evidenceRefs)
      : [];
    const latestPlanByConversationId = new Map();
    const independentlyProjectedResults = [];
    const unlinkedPlans = [];
    // 目标线（Goal Thread）关系索引：从这批 plans 建一次，供两处 snapshot 组装共用。
    const relationIndex = buildGoalThreadRelationIndex(plans);
    const inScopeRootIds = collectInScopeThreadRoots(plans, scope, relationIndex);
    for (const rawPlan of plans) {
      if (!isGoalPlanInScope(rawPlan, scope) && !isGoalThreadContextPlan(rawPlan, relationIndex, inScopeRootIds)) {
        continue;
      }
      const plan = backfillCompletedPlanQualityReview(goalPlanStore, rawPlan);
      const snapshot = toGoalPlanSnapshot(plan, { relationIndex, evidenceIndex, artifactRoots });
      const projected = snapshot ? projectGoalPlan(snapshot) : null;
      // 验收事实属于 GoalPlan：同一会话可同时存在多个待验收结果，必须逐项投影，
      // 不能混入 conversation 级去重后形成用户看不见的验收队列。
      if (projected?.actionRight === 'result_ready') {
        independentlyProjectedResults.push(plan);
        continue;
      }
      const conversationId = typeof plan?.conversationId === 'string' ? plan.conversationId : '';
      if (!conversationId) {
        unlinkedPlans.push(plan);
        continue;
      }
      const current = latestPlanByConversationId.get(conversationId);
      const currentUpdatedAt = Date.parse(current?.updatedAt ?? current?.createdAt ?? '');
      const nextUpdatedAt = Date.parse(plan?.updatedAt ?? plan?.createdAt ?? '');
      if (!current || !Number.isFinite(currentUpdatedAt) || nextUpdatedAt >= currentUpdatedAt) {
        latestPlanByConversationId.set(conversationId, plan);
      }
    }
    for (const plan of [
      ...independentlyProjectedResults,
      ...latestPlanByConversationId.values(),
      ...unlinkedPlans,
    ]) {
      const conversationId =
        typeof plan?.conversationId === 'string' ? plan.conversationId : undefined;
      const conversation = conversationId ? conversationById.get(conversationId) : undefined;
      const snapshot = toGoalPlanSnapshot(plan, {
        conversation,
        providerIndex,
        relationIndex,
        evidenceIndex,
        artifactRoots,
      });
      if (!snapshot) continue;
      // nowMs 与列表过滤时钟一致，保证 durationMs 与 active 窗同源。
      const projected = projectGoalPlan(snapshot, { nowMs });
      // 行动权任务流：有 GoalPlan 时主标题 = plan.title（projected.title）。
      // conversation.title 不得压过任务名；currentGoalTitle 改为当前步骤（若有）。
      const stepTitle = currentStepTitleFromItem(projected);
      const lastActiveMs = Date.parse(projected.lastActiveAt ?? '');
      const readAtMs = Date.parse(conversation?.lastReadAt ?? '');
      const isUnread =
        Boolean(conversation) &&
        Number.isFinite(lastActiveMs) &&
        (!Number.isFinite(readAtMs) || lastActiveMs > readAtMs);
      if (conversation) {
        projectedPlanConversationIds.add(snapshot.conversationId);
        items.push({
          ...projected,
          title: projected.title,
          isUnread,
          ...(stepTitle ? { currentGoalTitle: stepTitle } : {}),
        });
      } else {
        items.push({
          ...projected,
          isUnread: false,
          ...(stepTitle ? { currentGoalTitle: stepTitle } : {}),
        });
      }
    }

    for (const conversation of conversations) {
      const conversationId =
        typeof conversation?.id === 'string' ? conversation.id.trim() : '';
      if (!conversationId || projectedPlanConversationIds.has(conversationId)) continue;
      if (
        workspacePath &&
        normalizeWorkspacePath(conversation.workspacePath) !== normalizeWorkspacePath(workspacePath)
      ) {
        continue;
      }
      if (
        activeWithinMs > 0 &&
        !isWithinActiveWindow(conversation.updatedAt, activeWithinMs, nowMs)
      ) {
        continue;
      }
      // 会话历史始终保留；lastReadAt 仅供协议投影已读/未读状态。
      // 活跃任务 conversation 已在 projectedPlanConversationIds 排除（一会话一投影）。
      const labels = resolveConversationModelLabels(conversation, providerIndex);
      items.push(projectConversation({
        conversationId,
        title: displayConversationTitle(conversation.title, '未命名沟通'),
        workspaceLabel: workspaceLabelFromPath(conversation.workspacePath),
        updatedAt: conversation.updatedAt,
        lastReadAt: conversation.lastReadAt ?? null,
        ...(labels.modelLabel ? { modelLabel: labels.modelLabel } : {}),
        ...(labels.providerLabel ? { providerLabel: labels.providerLabel } : {}),
      }));
    }

    let definitions = [];
    try {
      definitions = automationStore.listDefinitions() ?? [];
    } catch {
      definitions = [];
    }
    for (const definition of definitions) {
      const automationId = definition?.automationId ?? definition?.id;
      let latestRun;
      if (automationId) {
        try {
          latestRun = automationStore.listRuns({ automationId, limit: 1 })?.[0];
        } catch {
          latestRun = undefined;
        }
      }
      if (!isAutomationInScope(definition, latestRun, scope)) continue;
      const snapshot = toAutomationSnapshot(definition, latestRun);
      if (!snapshot) continue;
      items.push(projectAutomationRun(snapshot));
    }

    // Peer 开启的后台 shell 线程：工作台「Peer 正在推进」桶。
    let shellTasks = [];
    if (typeof listShellTasks === 'function') {
      try {
        const listed = listShellTasks();
        shellTasks = Array.isArray(listed) ? listed : [];
      } catch {
        shellTasks = [];
      }
    }
    for (const task of shellTasks) {
      const projected = projectShellTaskIfInScope(task, scope);
      if (projected) items.push(projected);
    }

    const scopedItems = conversationId
      ? items.filter((item) => item?.conversationId === conversationId)
      : items;
    const sorted = sortTaskOverview(scopedItems);
    // 分桶截断（2026-08-14 修复）：result_ready 单独配额，不再挤占
    // peer_advancing / discussion 的空间；其余桶共享 limit。
    const capped = capTaskOverviewByBucket(sorted, limit, resultReadyLimit);
    // 首页无 conversationId 时只能整表重拉。按 taskId 复用未变卡片，
    // 一路流式/秒数更新不会把其余推进卡一起换成新对象。
    const previousItems = previousItemsByQuery.get(queryKey) ?? [];
    const reusedItems = reuseUnchangedTaskOverviewItems(previousItems, capped);
    previousItemsByQuery.set(queryKey, reusedItems);
    return reusedItems;
  }

  function markTasksRead(params = {}) {
    const conversationIds = Array.isArray(params.conversationIds)
      ? [...new Set(params.conversationIds.map((id) => String(id || '').trim()).filter(Boolean))]
      : [];
    if (typeof markTaskRead !== 'function' || conversationIds.length === 0) {
      return { markedCount: 0 };
    }
    for (const conversationId of conversationIds) {
      markTaskRead(conversationId);
    }
    return { markedCount: conversationIds.length };
  }

  return Object.freeze({ listTaskOverview, markTasksRead });
}

/**
 * 将 runtime shell task 快照投影为 TaskOverviewItem；不在当前 workspace / 不在活跃窗时返回 null。
 * 工作台默认只展示 running；includeTerminal 时也展示已结束任务。
 */
export function projectShellTaskIfInScope(task, scope = {}) {
  if (!task || typeof task !== 'object') return null;
  const taskId = typeof task.taskId === 'string' ? task.taskId.trim() : '';
  if (!taskId) return null;
  const status = String(task.status ?? '').trim().toLowerCase();
  const running = status === 'running' || status === '';
  if (!running && scope.includeTerminal !== true) return null;

  const cwd = typeof task.cwd === 'string' ? task.cwd : '';
  const wanted = normalizeWorkspacePath(scope.workspacePath);
  if (wanted) {
    const taskWs = normalizeWorkspacePath(cwd);
    // cwd 通常是 workspace 内路径；用前缀匹配覆盖子目录 cwd。
    if (taskWs && taskWs !== wanted && !taskWs.startsWith(`${wanted}/`) && !wanted.startsWith(`${taskWs}/`)) {
      return null;
    }
  }

  const startedAt = typeof task.startedAt === 'string' ? task.startedAt : undefined;
  const completedAt =
    typeof task.completedAt === 'string' && task.completedAt.trim() !== ''
      ? task.completedAt
      : null;
  const activeIso = completedAt || startedAt;
  if (
    !running &&
    !isWithinActiveWindow(activeIso, scope.activeWithinMs, scope.nowMs ?? Date.now())
  ) {
    return null;
  }

  return projectShellBackgroundTask({
    taskId,
    command: typeof task.command === 'string' ? task.command : '',
    status: running ? 'running' : status,
    workspaceLabel: workspaceLabelFromPath(cwd),
    cwd: cwd || undefined,
    startedAt,
    completedAt,
    toolCallId: typeof task.toolCallId === 'string' ? task.toolCallId : undefined,
  });
}

const ACTION_RIGHT_ORDER = {
  needs_you: 0,
  result_ready: 1,
  peer_advancing: 2,
  paused: 3,
  terminal: 4,
};

/**
 * 按行动权分桶截断 —— 取代单一全局 slice，保证任何一桶不会被另一桶挤空。
 *
 * 回归背景（2026-08-14）：历史积压的 result_ready（无验收记录的 completed）
 * 一次性涌入时，ACTION_RIGHT_ORDER 中 result_ready 排在 peer_advancing /
 * discussion 之前，旧的全局 `sorted.slice(0, limit)` 会先截满 result_ready，
 * 把「Peer 正在推进」「讨论」整桶挤掉，工作台只剩待验收卡。
 *
 * 契约：needs_you / peer_advancing / paused / discussion 共享主配额 limit
 * （按排序原样保留）；result_ready 单独配额（产品语义：不限条，用极大值），
 * 只有显式传入较小 resultReadyLimit 时才截断。
 */
export function capTaskOverviewByBucket(items, limit, resultReadyLimit = Number.MAX_SAFE_INTEGER) {
  const shareBudget = new Map();
  const resultBudget = Number.isFinite(resultReadyLimit) && resultReadyLimit > 0
    ? Math.floor(resultReadyLimit)
    : Number.MAX_SAFE_INTEGER;
  const capped = [];
  for (const item of items) {
    if (item?.actionRight === 'result_ready') {
      const used = shareBudget.get('result_ready') ?? 0;
      if (used >= resultBudget) continue;
      shareBudget.set('result_ready', used + 1);
      capped.push(item);
      continue;
    }
    // discussion 等无 ACTION_RIGHT_ORDER 键的桶与行动权桶共享主配额，
    // 但不再被 result_ready 抢占空间。
    const used = shareBudget.get('shared') ?? 0;
    if (used >= limit) continue;
    shareBudget.set('shared', used + 1);
    capped.push(item);
  }
  return capped;
}

/** 行动权分组排序 + 组内最近活跃倒序（稳定，不破坏相等元素相对顺序）。 */
export function sortTaskOverview(items) {
  const decorated = items.map((item, index) => ({ item, index }));
  decorated.sort((a, b) => {
    const orderDiff =
      (ACTION_RIGHT_ORDER[a.item.actionRight] ?? 99) -
      (ACTION_RIGHT_ORDER[b.item.actionRight] ?? 99);
    if (orderDiff !== 0) return orderDiff;
    const timeDiff = Date.parse(b.item.lastActiveAt ?? '') - Date.parse(a.item.lastActiveAt ?? '');
    if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff;
    return a.index - b.index;
  });
  return decorated.map((entry) => entry.item);
}
