import { collectToolEvidenceRefs } from '@peer-agent/runtime-core';
import { materializeToolResultContent } from '@peer-agent/runtime-node';

import { executeProjectedModelTool } from './projected-tool-executor.mjs';
import {
  decideGoalToolReplay,
  createGoalIdempotencyLedger,
} from '@peer-agent/runtime-core';
import { createDurableGoalIdempotencyLedger } from '@peer-agent/runtime-core/goal-idempotency-durable';
import { pathOf } from '../data-store.mjs';

export function createToolContext({
  conversationId = null,
  workspacePath = null,
  mode = 'chat',
  onToolCall = null,
  originWorkspacePath = null,
  targetWorkspacePath = null,
  readableRoots = null,
  writableRoots = null,
  permissionPolicy = null,
} = {}) {
  return {
    conversationId,
    workspacePath,
    originWorkspacePath,
    targetWorkspacePath,
    readableRoots,
    writableRoots,
    permissionPolicy,
    // 当前回合的交互模式（chat/goal/...）。由 llm-chat-service 在每次 run 时写入，
    // 供 goal 模式运行时闸门在工具执行层判定准入。见 Goal 模式运行时闸门设计。
    mode,
    // Goal Runner 进度 sink：每次工具调用派发时回调一次，用于实时工具计数。
    // 经 toolContext 透传，是覆盖所有 provider 的单一接缝。
    onToolCall,
    readFiles: new Map(),
  };
}

export function safeParseJson(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function materializeToolOutput(result) {
  return result.output || (result.success ? '' : `Error: ${result.error}${result.stderr ? '\n' + result.stderr : ''}`);
}

const REQUEST_USER_INPUT_TOOL = 'request_user_input';

// 发给渲染层 UI 流（chat:stream:tool-result）的工具结果体量上界。
// 仅约束「给用户看的那一份」；回灌给模型的工具结果（toolExecution.output）不受此限。
const STREAM_RESULT_CHAR_LIMIT = 4000;
// 结构化聚合结果（batch_search）在 UI 流里保留的最大命中条数。
// 卡片只需展示概览，超出部分按条数裁剪并标记 truncated，而非按字节切断 JSON。
const STREAM_AGGREGATE_MATCH_CAP = 50;
const STREAM_JSON_PREVIEW_MIN_CHARS = 512;

function isRequestUserInputTool(name) {
  return name === REQUEST_USER_INPUT_TOOL || (typeof name === 'string' && name.endsWith(`.${REQUEST_USER_INPUT_TOOL}`));
}

/**
 * 把结构化聚合结果（batch_search 的 local_capability_result_ref JSON）按「结果条数」
 * 裁剪后重新序列化，保证产出仍是**合法 JSON**。
 *
 * 背景（方案 B2）：UI 流此前对所有工具结果一律 `output.slice(0, N)` 字节级截断。
 * 对 bash 等纯文本无妨，但 batch_search 的结果是一整段 JSON，从中间切断会变成
 * 非法 JSON，渲染层 `JSON.parse` 失败 → 卡片永远卡在 searching。这里改为：识别
 * 结构化聚合结果时，仅裁剪冗长的 aggregated.matches（按条数封顶）并丢弃给模型看的
 * preview 纯文本副本（渲染卡片只消费 lanes/aggregated，不消费 preview），再整体
 * 重新 stringify，使产出既有界又始终可被解析。
 *
 * 非结构化或解析失败时返回 null，交由调用方回退到原有的字节级截断。
 */
function boundAggregateStreamPayload(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const preview = parsed.outputPreview;
  const aggregated = preview && typeof preview === 'object' ? preview.aggregated : undefined;
  if (!aggregated || typeof aggregated !== 'object' || !Array.isArray(aggregated.matches)) {
    return null;
  }
  const cappedMatches = aggregated.matches.slice(0, STREAM_AGGREGATE_MATCH_CAP);
  const bounded = {
    ...parsed,
    outputPreview: {
      ...preview,
      // preview 是给模型看的纯文本副本，渲染卡片不消费；从 UI 流剔除以省体积。
      preview: undefined,
      aggregated: {
        ...aggregated,
        matches: cappedMatches,
        truncated: Boolean(aggregated.truncated) || cappedMatches.length < aggregated.matches.length,
      },
    },
  };
  return JSON.stringify(bounded);
}

function fitJsonPreviewWithinLimit({ makePayload, makePreview, limit = STREAM_RESULT_CHAR_LIMIT }) {
  let previewChars = Math.max(STREAM_JSON_PREVIEW_MIN_CHARS, limit - 800);
  while (previewChars >= STREAM_JSON_PREVIEW_MIN_CHARS) {
    const payload = makePayload(makePreview(previewChars));
    const text = JSON.stringify(payload);
    if (text.length <= limit) return text;
    const overflow = text.length - limit;
    previewChars -= Math.max(128, overflow + 32);
  }
  return JSON.stringify(makePayload(makePreview(STREAM_JSON_PREVIEW_MIN_CHARS)));
}

function topLevelString(record, key) {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function boundGenericJsonStreamPayload(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const record = Array.isArray(parsed) ? {} : parsed;
  return fitJsonPreviewWithinLimit({
    makePreview: (previewChars) => output.slice(0, previewChars),
    makePayload: (preview) => ({
      kind: topLevelString(record, 'kind') || 'truncated_tool_result_preview',
      tool: topLevelString(record, 'tool'),
      capabilityId: topLevelString(record, 'capabilityId'),
      status: topLevelString(record, 'status'),
      evidenceRefs: Array.isArray(record.evidenceRefs) ? record.evidenceRefs : undefined,
      truncated: true,
      originalChars: output.length,
      outputPreview: {
        status: topLevelString(record.outputPreview, 'status') || topLevelString(record, 'status') || 'truncated',
        truncated: true,
        preview,
      },
    }),
  });
}

/**
 * 给 UI 流的工具结果套上界：短结果原样透传；超限时，结构化聚合结果按条数裁剪并
 * 保持合法 JSON（方案 B2）。其它 JSON 结果改为合法 JSON preview wrapper；
 * 非 JSON 纯文本才回退到字节级截断。
 */
function boundToolResultForStream(output) {
  if (typeof output !== 'string') return '';
  if (output.length <= STREAM_RESULT_CHAR_LIMIT) return output;
  const bounded = boundAggregateStreamPayload(output);
  if (bounded !== null) return bounded;
  const boundedJson = boundGenericJsonStreamPayload(output);
  if (boundedJson !== null) return boundedJson;
  return output.slice(0, STREAM_RESULT_CHAR_LIMIT);
}

export function formatToolResultForStream({ name, args, output }) {
  if (isRequestUserInputTool(name)) {
    const question = typeof args?.question === 'string' ? args.question.trim() : '';
    if (question) {
      const options = Array.isArray(args?.options)
        ? args.options.filter((option) => typeof option === 'string' && option.trim()).map((option) => option.trim())
        : [];
      const note = typeof args?.note === 'string' ? args.note.trim() : undefined;
      return JSON.stringify({
        ok: true,
        acknowledged: true,
        question,
        options,
        ...(note ? { note } : {}),
      });
    }
    // 无 question：按普通工具结果处理（落到下面的有界逻辑）。
  }
  return boundToolResultForStream(output);
}

function addStringRefs(target, value) {
  if (typeof value === 'string' && value.trim()) {
    target.add(value.trim());
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) target.add(item.trim());
  }
}

export { collectToolEvidenceRefs };

function mergeEvidenceRefs(existing, incoming) {
  const refs = new Set();
  addStringRefs(refs, existing);
  addStringRefs(refs, incoming);
  return Array.from(refs);
}

export function appendEvidenceRefsToToolOutput(output, evidenceRefs) {
  const refs = mergeEvidenceRefs([], evidenceRefs);
  if (refs.length === 0) return output;

  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify({
          ...parsed,
          evidenceRefs: mergeEvidenceRefs(parsed.evidenceRefs, refs),
        }, null, 2);
      }
    } catch {
      // Fall through to plaintext annotation.
    }
    return `${output}\n\nEvidence refs: ${JSON.stringify(refs)}`;
  }

  return JSON.stringify({ output, evidenceRefs: refs }, null, 2);
}

/**
 * 从 Runtime Projection 按 capability name 反查后端注入的展示文案 displayName。
 * 用于把工具卡标题（尤其是 MCP 工具的「服务名: 工具名」）随 tool-call 事件透传给表达层。
 * 找不到时返回 null，由渲染层回退到裸 capability 名，保持既有行为不被破坏。
 */
export function resolveCapabilityDisplayName(runtimeProjection, name) {
  const capability = (runtimeProjection?.capabilities ?? []).find(
    (candidate) => candidate?.name === name,
  );
  const displayName = capability?.displayName;
  return typeof displayName === 'string' && displayName.length > 0 ? displayName : null;
}

/**
 * 从一次工具执行结果中提取「回合控制信号」。
 * interaction 能力用它把控制权交还用户；Goal 创建能力用它结束 intake 工具回合，
 * 让编排层把执行权交给 Goal Runner。信号必须来自 Provider 的结构化 Tool Result，
 * 不能由 assistant 文本冒充。详见 local-interaction-provider.mjs 与 local-goal-provider.mjs。
 */
export function extractToolControlSignal(result) {
  const control = result?.execution?.result?.outputPreview?.control;
  if (control && typeof control === 'object' && control.terminal === true) {
    return { terminal: true, reason: control.reason ?? null };
  }
  return null;
}

// Milestone D+: durable Goal tool idempotency ledger cache (planId+runId).
// Falls back to process-local ledger when plan/run identity is incomplete.
const goalIdempotencyLedgerCache = new Map();
const processLocalGoalIdempotencyLedger = createGoalIdempotencyLedger();

function resolveGoalIdempotencyLedger({ goalPlanStore = null, planId = null, runId = null } = {}) {
  const normalizedPlanId = typeof planId === 'string' ? planId.trim() : '';
  const normalizedRunId = typeof runId === 'string' ? runId.trim() : '';
  if (!normalizedPlanId || !normalizedRunId) {
    return processLocalGoalIdempotencyLedger;
  }
  const cacheKey = `${normalizedPlanId}::${normalizedRunId}`;
  const cached = goalIdempotencyLedgerCache.get(cacheKey);
  if (cached) return cached;

  let storeDir = null;
  if (goalPlanStore && typeof goalPlanStore.getStoreDir === 'function') {
    try {
      storeDir = goalPlanStore.getStoreDir();
    } catch {
      storeDir = null;
    }
  }
  if (!storeDir) {
    try {
      storeDir = pathOf('goalPlans');
    } catch {
      storeDir = null;
    }
  }
  const ledger = storeDir
    ? createDurableGoalIdempotencyLedger({
      storeDir,
      planId: normalizedPlanId,
      runId: normalizedRunId,
    })
    : processLocalGoalIdempotencyLedger;
  goalIdempotencyLedgerCache.set(cacheKey, ledger);
  return ledger;
}

export async function executeModelToolCall({
  name,
  rawArguments,
  toolCallId,
  workspacePath,
  toolContext,
  permissionGate,
  webContents,
  streamId,
  conversationId,
  signal,
  registry,
  runtimeProjection,
  mcpRegistry,
  skillStore = null,
  goalPlanStore,
  automationProposalService = null,
  ensureBrowserReady = null,
}) {
  const args = safeParseJson(rawArguments);
  // displayName 是后端 Runtime Projection 注入的固定展示文案（MCP 工具为
  // 「服务名: 工具名」），表达层用它渲染工具卡标题。这里按 name 从投影反查并随
  // tool-call 事件透传，避免渲染层只能显示裸 capability 名（如 mcp__server__tool）。
  const displayName = resolveCapabilityDisplayName(runtimeProjection, name);
  // 工具生命周期时间以主进程为真值来源：覆盖权限等待与实际执行，renderer 只负责展示。
  const startedAtMs = Date.now();
  webContents.send('chat:stream:tool-call', {
    streamId,
    tool: name,
    displayName,
    args,
    toolCallId,
    startedAtMs,
  });
  // Goal Runner 实时工具计数：在工具派发处经 toolContext 透传单一接缝触发，覆盖所有 provider。
  if (typeof toolContext?.onToolCall === 'function') {
    try {
      // 透传已解析的工具入参（args），供 Goal Runner 等消费者按工具语义收集请求
      // （如 request_explorer 的 question/scope）。仅用 {tool,toolCallId} 的旧消费者
      // 不受影响——多传字段向后兼容。
      toolContext.onToolCall({ tool: name, toolCallId, input: args });
    } catch {
      // 进度回调失败不得影响工具执行。
    }
  }
  const requestFilePermission = permissionGate.createFilePermissionRequester({
    webContents,
    streamId,
    toolCallId,
    conversationId,
    permissionPolicy: toolContext.permissionPolicy,
  });
  const requestLocalCapabilityPermission = permissionGate.createLocalCapabilityPermissionRequester({
    webContents,
    streamId,
    toolCallId,
    conversationId,
    workspacePath,
    permissionPolicy: toolContext.permissionPolicy,
  });

  // Milestone D: Goal side-effect guard. When Goal context is present, avoid
  // replaying completed / still-running non-idempotent tool attempts after resume.
  const goalRuntime = toolContext?.goalRuntime && typeof toolContext.goalRuntime === 'object'
    ? toolContext.goalRuntime
    : null;
  const goalPlanId = goalRuntime?.planId
    || toolContext?.planId
    || (typeof goalPlanStore?.getActivePlanByConversation === 'function'
      ? goalPlanStore.getActivePlanByConversation(conversationId)?.planId
      : null);
  const goalPlan = goalPlanId && typeof goalPlanStore?.getPlan === 'function'
    ? goalPlanStore.getPlan(goalPlanId)
    : null;
  if (goalPlan?.runner?.runId) {
    const goalIdempotencyLedger = resolveGoalIdempotencyLedger({
      goalPlanStore,
      planId: goalPlan.planId,
      runId: goalPlan.runner.runId,
    });
    const decision = decideGoalToolReplay({
      planId: goalPlan.planId,
      runId: goalPlan.runner.runId,
      taskId: goalPlan.runner.currentTaskId || null,
      toolName: name,
      args,
      openToolCalls: goalPlan.runner.contextCheckpoint?.openToolCalls || [],
      completedLedger: goalIdempotencyLedger.snapshot(),
    });
    if (decision.action === 'reuse') {
      const reused = {
        ok: true,
        reused: true,
        idempotencyKey: decision.idempotencyKey,
        evidenceRefs: decision.evidenceRefs || [],
        content: `Reused completed tool result via idempotency key ${decision.idempotencyKey.slice(0, 12)}…`,
        result: {
          reused: true,
          idempotencyKey: decision.idempotencyKey,
          evidenceRefs: decision.evidenceRefs || [],
        },
      };
      webContents?.send?.('chat:stream:tool-result', {
        streamId,
        toolCallId,
        result: reused.content,
        evidenceRefs: reused.evidenceRefs,
        startedAtMs,
        completedAtMs: Date.now(),
        reused: true,
      });
      return {
        aborted: false,
        args,
        output: reused.content,
        result: reused,
        controlSignal: null,
      };
    }
    if (decision.action === 'query_status' || decision.action === 'block' || decision.action === 'ask_user') {
      const blocked = {
        ok: false,
        blocked: true,
        reason: decision.reason,
        action: decision.action,
        idempotencyKey: decision.idempotencyKey,
        mutationClass: decision.mutationClass,
        content: `Blocked tool replay (${decision.action}): ${decision.reason}`,
      };
      webContents?.send?.('chat:stream:tool-result', {
        streamId,
        toolCallId,
        result: blocked.content,
        evidenceRefs: [],
        startedAtMs,
        completedAtMs: Date.now(),
        blocked: true,
      });
      return {
        aborted: false,
        args,
        output: blocked.content,
        result: blocked,
        controlSignal: null,
      };
    }
    // Fresh execute: attach idempotency key on toolContext for downstream evidence.
    if (toolContext && typeof toolContext === 'object') {
      toolContext.idempotencyKey = decision.idempotencyKey;
      toolContext.goalIdempotency = {
        ...decision,
        planId: goalPlan.planId,
        runId: goalPlan.runner.runId,
      };
    }
  }

  const result = await executeProjectedModelTool({
    name,
    args,
    workspacePath,
    toolContext,
    toolCallId,
    requestPermission: (request) => {
      if (request?.confirmation) return requestLocalCapabilityPermission(request);
      if (request?.filePath || request?.tool || request?.workspacePath) return requestFilePermission(request);
      return requestLocalCapabilityPermission(request);
    },
    shellApprovalDecider: permissionGate.createShellApprovalDecider({
      webContents,
      streamId,
      toolCallId,
      conversationId,
      workspacePath,
      permissionPolicy: toolContext.permissionPolicy,
    }),
    signal,
    registry,
    runtimeProjection,
    mcpRegistry,
    skillStore,
    goalPlanStore,
    automationProposalService,
    ensureBrowserReady,
  });
  if (signal?.aborted) {
    const endedAtMs = Date.now();
    webContents.send('chat:stream:tool-result', {
      streamId,
      toolCallId,
      result: '工具调用已中断',
      evidenceRefs: [],
      startedAtMs,
      endedAtMs,
      durationMs: Math.max(0, endedAtMs - startedAtMs),
    });
    return { aborted: true, args, output: '' };
  }
  const rawOutput = materializeToolOutput(result);
  const evidenceRefs = collectToolEvidenceRefs({ toolCallId, execution: result.execution });
  if (evidenceRefs.length > 0 && typeof goalPlanStore?.recordEvidenceRefs === 'function') {
    try {
      goalPlanStore.recordEvidenceRefs({
        conversationId,
        streamId,
        toolCallId,
        toolName: name,
        capabilityId: result.execution?.call?.capabilityId,
        evidenceRefs,
        artifactRefs: evidenceRefs.filter((ref) => !ref.startsWith('tool-result://')),
      });
    } catch (err) {
      console.warn('[tool-orchestrator] failed to register EvidenceIndex refs:', err);
    }
  }
  const output = appendEvidenceRefsToToolOutput(rawOutput, evidenceRefs);
  const streamResult = formatToolResultForStream({ name, args, output });
  // Layer 0 材料化(17 号文档 §3.1 / 23 号台账阶段 E):回灌给模型的超阈值输出
  // 落盘 artifact,消息内只留 ref 骨架(预览+检索命令);UI 流(streamResult)不受影响。
  // 已是结构化 local_*_ref 的输出(shell/file/batch_search)在内部直接跳过。
  let providerOutput = output;
  try {
    providerOutput = materializeToolResultContent({
      conversationId,
      toolCallId,
      tool: name,
      content: output,
      isError: !result.success,
    }).content;
  } catch (err) {
    console.warn('[tool-orchestrator] tool result materialization failed, falling back to inline output:', err?.message || err);
  }
  const endedAtMs = Date.now();
  webContents.send('chat:stream:tool-result', {
    streamId,
    toolCallId,
    result: streamResult,
    evidenceRefs,
    startedAtMs,
    endedAtMs,
    durationMs: Math.max(0, endedAtMs - startedAtMs),
  });
  // Remember successful Goal tool completions for future resume reuse.
  if (
    toolContext?.idempotencyKey
    && result
    && result.ok !== false
    && !result.blocked
    && !result.reused
  ) {
    try {
      const evidenceRefs = Array.isArray(result.evidenceRefs)
        ? result.evidenceRefs
        : Array.isArray(result?.result?.evidenceRefs)
          ? result.result.evidenceRefs
          : [];
      const decisionMeta = toolContext.goalIdempotency || {};
      const rememberPlanId = decisionMeta.planId
        || toolContext.goalRuntime?.planId
        || toolContext.planId
        || null;
      const rememberRunId = decisionMeta.runId
        || toolContext.goalRuntime?.runId
        || null;
      // Prefer identity from the decision key material when available.
      const ledger = resolveGoalIdempotencyLedger({
        goalPlanStore,
        planId: rememberPlanId,
        runId: rememberRunId,
      });
      ledger.remember({
        idempotencyKey: toolContext.idempotencyKey,
        status: 'completed',
        evidenceRefs,
        toolCallId,
        toolName: name,
        planId: rememberPlanId || undefined,
        runId: rememberRunId || undefined,
      });
    } catch {
      // ledger write must never fail tool return path
    }
  }

  const controlSignal = extractToolControlSignal(result);
  const visualObservations = Array.isArray(result.execution?.result?.modelContext?.visualObservations)
    ? result.execution.result.modelContext.visualObservations.filter((observation) => (
        observation?.kind === 'browser_screenshot'
        && observation?.mediaType === 'image/png'
        && typeof observation?.artifactRef === 'string'
        && observation.artifactRef.startsWith('local-browser-artifact://')
        && typeof observation?.dataUrl === 'string'
        && observation.dataUrl.startsWith('data:image/png;base64,')
      ))
    : [];
  return {
    aborted: false,
    args,
    output: providerOutput,
    result,
    controlSignal,
    // Side-band, current-turn-only visual context. It is deliberately excluded from
    // output/providerOutput so Evidence and tool cards never persist image bytes.
    visualObservations,
  };
}
