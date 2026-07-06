import { executeProjectedModelTool } from './projected-tool-executor.mjs';

export function createToolContext({
  conversationId = null,
  workspacePath = null,
  mode = 'chat',
  onToolCall = null,
  originWorkspacePath = null,
  targetWorkspacePath = null,
  readableRoots = null,
  writableRoots = null,
} = {}) {
  return {
    conversationId,
    workspacePath,
    originWorkspacePath,
    targetWorkspacePath,
    readableRoots,
    writableRoots,
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

/**
 * 给 UI 流的工具结果套上界：短结果原样透传；超限时，结构化聚合结果按条数裁剪并
 * 保持合法 JSON（方案 B2），其余（纯文本）回退到字节级截断以维持既有行为。
 */
function boundToolResultForStream(output) {
  if (typeof output !== 'string') return '';
  if (output.length <= STREAM_RESULT_CHAR_LIMIT) return output;
  const bounded = boundAggregateStreamPayload(output);
  if (bounded !== null) return bounded;
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

export function collectToolEvidenceRefs({ toolCallId, execution } = {}) {
  const refs = new Set();
  if (typeof toolCallId === 'string' && toolCallId.trim()) {
    refs.add(`tool-result://${toolCallId.trim()}`);
  }

  const result = execution?.result;
  const evidence = result?.evidence;
  addStringRefs(refs, evidence?.artifactRefs);

  const outputPreview = result?.outputPreview;
  addStringRefs(refs, outputPreview?.artifactRef);
  addStringRefs(refs, outputPreview?.artifactRefs);
  addStringRefs(refs, outputPreview?.localToolResultRef?.artifactRef);
  addStringRefs(refs, outputPreview?.localToolResultRef?.artifactRefs);

  return Array.from(refs);
}

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
 * 目前唯一来源是无副作用的 interaction 能力（request_user_input），它在 Evidence 的
 * outputPreview.control 里标记 { terminal: true }，用于让 agent loop 在本回合收尾后
 * 停止回灌、把控制权交还给用户（而不是自行继续决策）。详见 local-interaction-provider.mjs。
 */
export function extractToolControlSignal(result) {
  const control = result?.execution?.result?.outputPreview?.control;
  if (control && typeof control === 'object' && control.terminal === true) {
    return { terminal: true, reason: control.reason ?? null };
  }
  return null;
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
  goalPlanStore,
}) {
  const args = safeParseJson(rawArguments);
  // displayName 是后端 Runtime Projection 注入的固定展示文案（MCP 工具为
  // 「服务名: 工具名」），表达层用它渲染工具卡标题。这里按 name 从投影反查并随
  // tool-call 事件透传，避免渲染层只能显示裸 capability 名（如 mcp__server__tool）。
  const displayName = resolveCapabilityDisplayName(runtimeProjection, name);
  webContents.send('chat:stream:tool-call', { streamId, tool: name, displayName, args, toolCallId });
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
  });
  const requestLocalCapabilityPermission = permissionGate.createLocalCapabilityPermissionRequester({
    webContents,
    streamId,
    toolCallId,
    conversationId,
    workspacePath,
  });
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
    }),
    signal,
    registry,
    runtimeProjection,
    mcpRegistry,
    goalPlanStore,
  });
  if (signal?.aborted) return { aborted: true, args, output: '' };
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
  webContents.send('chat:stream:tool-result', { streamId, toolCallId, result: streamResult, evidenceRefs });
  const controlSignal = extractToolControlSignal(result);
  return { aborted: false, args, output, result, controlSignal };
}
