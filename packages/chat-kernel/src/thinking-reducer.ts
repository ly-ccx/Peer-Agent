import type {
  ClientToolStatus,
  IterationNode,
  PendingHumanConfirmation,
  SkillStep,
  ThinkingProcess,
  ToolCard,
} from '@zeus-atlas/protocol';
import { normalizePendingHumanConfirmation } from './confirmation-reducer.ts';

const DEFAULT_MAX_ITERATIONS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 判断 inputArguments 是否携带有意义的参数内容。
 * 空对象 {} / null / undefined 均视为「无内容」，不应覆盖已有的有效参数。
 * 用于 appendToolCard 去重合并分支的"只升级不降级"守卫。
 */
function hasSubstantiveArgs(args: unknown): boolean {
  if (args === null || args === undefined) return false;
  if (typeof args === 'string') return args.length > 0;
  if (isRecord(args)) return Object.keys(args).length > 0;
  return false;
}

function readString(data: unknown, keys: readonly string[]): string | undefined {
  if (typeof data === 'string') return data;
  if (!isRecord(data)) return undefined;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function readNumber(data: unknown, keys: readonly string[]): number | undefined {
  if (!isRecord(data)) return undefined;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export function createThinkingProcess(seed?: Partial<ThinkingProcess>): ThinkingProcess {
  return {
    expanded: true,
    iterations: [],
    maxIterations: seed?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    toolCount: seed?.toolCount ?? 0,
    status: seed?.status ?? 'running',
    ...seed,
  };
}

function createIteration(iteration: number, label?: string, executionUuid?: string): IterationNode {
  return {
    iteration,
    label,
    thinkingContent: '',
    toolCards: [],
    status: 'thinking',
    ...(executionUuid ? { executionUuid } : {}),
  };
}

function createToolCard(data: unknown, initialClientToolStatus?: ClientToolStatus): ToolCard {
  const toolCallId =
    readString(data, ['toolCallId', 'tool_call_id', 'callId', 'id']) ?? `tool_${Date.now()}`;
  const toolId = readString(data, ['toolId', 'tool_id', 'capabilityId', 'skillId', 'name']) ?? toolCallId;
  const displayName =
    readString(data, ['displayName', 'toolName', 'skillName', 'name']) ?? toolId;
  const capabilityId = readString(data, ['capabilityId']);

  // 参数读取：兼容多种后端格式。
  // - arguments / argumentsPreview：后端转换后的通用格式
  // - input：Claude API 原生 tool_use 格式（content_block_start 中的 input 字段）
  // - args：兼容其他格式
  let inputArguments: unknown;
  if (isRecord(data)) {
    if (data.arguments !== undefined) inputArguments = data.arguments;
    else if (data.argumentsPreview !== undefined) inputArguments = data.argumentsPreview;
    else if (data.input !== undefined && isRecord(data.input) && Object.keys(data.input as object).length > 0) inputArguments = data.input;
    else if (data.args !== undefined) inputArguments = data.args;
  }

  return {
    toolCallId,
    toolId,
    displayName,
    status: 'running',
    steps: [],
    ...(capabilityId ? { capabilityId } : {}),
    ...(inputArguments !== undefined ? { inputArguments } : {}),
    ...(readString(data, ['argsSource']) ? { inputArgumentsSource: readString(data, ['argsSource']) } : {}),
    ...(readString(data, ['argsNote']) ? { inputArgumentsNote: readString(data, ['argsNote']) } : {}),
    ...(readString(data, ['executionUuid']) ? { executionUuid: readString(data, ['executionUuid']) } : {}),
    ...(initialClientToolStatus ? { clientToolStatus: initialClientToolStatus } : {}),
  };
}

/**
 * 把 client tool 的细粒度生命周期阶段折叠成 ToolCard.status 上的通用语义，
 * 让现有渲染（按 running/completed/error/warning 着色）不用为 client tool 分叉。
 */
function deriveToolCardStatus(clientToolStatus: ClientToolStatus): ToolCard['status'] {
  switch (clientToolStatus) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'denied':
    case 'timeout':
    case 'cancelled':
      return 'error';
    default:
      return 'running';
  }
}

function createSkillStep(data: unknown, fallbackStep: number): SkillStep {
  const step = readNumber(data, ['step', 'stepIndex', 'index']) ?? fallbackStep;
  const title = readString(data, ['title', 'stepName', 'message', 'name']) ?? `Step ${step}`;

  return {
    step,
    title,
    status: 'running',
  };
}

/**
 * 把事件应用到目标轮次。
 *
 * 治本路径：事件带 (executionUuid, iteration) 复合 key 时精确定位——这是天然幂等
 * key，同时根治「不同 execution 同序号塌缩」和「forwardByRun 重放产生重复轮」。
 * 兜底路径：旧后端未注入 executionUuid 时回退到「操作最后一轮」，配合
 * appendThinkingContent / iteration_start 的「tool 后开新轮」ReAct 不变量分轮。
 */
function updateLastIteration(
  process: ThinkingProcess,
  updater: (iteration: IterationNode) => IterationNode,
  data?: unknown,
): ThinkingProcess {
  const executionUuid = readString(data, ['executionUuid']);
  const iteration = readNumber(data, ['iteration', 'round']);
  if (executionUuid !== undefined && iteration !== undefined) {
    const iterations = [...process.iterations];
    const idx = iterations.findIndex(
      (it) => it.executionUuid === executionUuid && it.iteration === iteration,
    );
    if (idx >= 0) {
      iterations[idx] = updater(iterations[idx]);
    } else {
      // 复合 key 未命中（工具/内容事件先于 iteration_start 到达）→ 补建该轮
      iterations.push(updater(createIteration(iteration, undefined, executionUuid)));
    }
    return { ...process, iterations };
  }
  // 兜底（旧后端未注入 executionUuid）：操作最后一轮
  const iterations = [...process.iterations];
  if (iterations.length === 0) {
    iterations.push(updater(createIteration(1)));
    return { ...process, iterations };
  }
  const lastIndex = iterations.length - 1;
  iterations[lastIndex] = updater(iterations[lastIndex]);
  return { ...process, iterations };
}

/**
 * ReAct 轮次边界推断：上一轮已经调用过工具（act），此刻又进入思考（think）
 * → 进入新一轮，应开新的 IterationNode。
 */
function shouldStartNewIteration(process: ThinkingProcess): boolean {
  const last = process.iterations[process.iterations.length - 1];
  return !!last && last.toolCards.length > 0;
}

function updateToolCard(
  iteration: IterationNode,
  data: unknown,
  updater: (tool: ToolCard) => ToolCard,
): IterationNode {
  const requestedToolCallId = readString(data, ['toolCallId', 'tool_call_id', 'callId', 'id']);
  const toolCards = [...iteration.toolCards];
  let index = requestedToolCallId
    ? toolCards.findIndex((item) => item.toolCallId === requestedToolCallId)
    : toolCards.findIndex((item) => item.status === 'running');

  if (index < 0) index = toolCards.length - 1;
  if (index < 0) return iteration;

  toolCards[index] = updater(toolCards[index]);
  return { ...iteration, toolCards };
}

function hasCompositeKey(data: unknown): boolean {
  return readString(data, ['executionUuid']) !== undefined
    && readNumber(data, ['iteration', 'round']) !== undefined;
}

function appendThinkingContent(process: ThinkingProcess, data: unknown): ThinkingProcess {
  const content = readString(data, ['content', 'delta', 'text', 'message']);
  if (!content) return process;

  // 兜底（无复合 key）：上一轮已 act 过工具后又来思考文本 → 开新一轮。
  // 治本（有复合 key）：轮次由 iteration_start 建/重置，这里只按复合 key 归轮 append
  // （重放时该轮 thinkingContent 已被 iteration_start 重置，这里重建出相同内容 → 幂等）。
  if (!hasCompositeKey(data) && shouldStartNewIteration(process)) {
    const last = process.iterations[process.iterations.length - 1];
    return {
      ...process,
      iterations: [
        ...process.iterations,
        { ...createIteration(last.iteration + 1), thinkingContent: content, status: 'thinking' },
      ],
    };
  }

  return updateLastIteration(process, (iteration) => ({
    ...iteration,
    thinkingContent: iteration.thinkingContent + content,
    status: 'thinking',
  }), data);
}

function appendToolCard(
  process: ThinkingProcess,
  data: unknown,
  initialClientToolStatus?: ClientToolStatus,
): ThinkingProcess {
  const card = createToolCard(data, initialClientToolStatus);
  // 同 toolCallId 去重：run-relay 第二阶段 forwardByRun 切到 exec-1 时
  // lastEventIdInCurrent=0，会从头重推 exec-1 已经在 send-stream 推过的 events
  // （含 tool_calling），如果不去重 thinking timeline 会出现两张同 toolCallId
  // 的 toolCard → React duplicate-key warning + UI 状态错乱。
  // 跟 upsertClientToolCard 对称，"已存在" 时只更新元信息不新建。
  return updateLastIteration(process, (iteration) => {
    const existingIndex = card.toolCallId
      ? iteration.toolCards.findIndex((tool) => tool.toolCallId === card.toolCallId)
      : -1;
    if (existingIndex >= 0) {
      // 只升级不降级：如果新卡的 inputArguments 是空对象 {}（run-relay 重推的
      // tool_calling 事件常见），不覆盖原卡已有的有效参数。
      const shouldOverrideArgs = hasSubstantiveArgs(card.inputArguments)
        || !hasSubstantiveArgs(iteration.toolCards[existingIndex].inputArguments);
      const merged: ToolCard = {
        ...iteration.toolCards[existingIndex],
        ...(card.capabilityId ? { capabilityId: card.capabilityId } : {}),
        ...(shouldOverrideArgs && card.inputArguments !== undefined ? { inputArguments: card.inputArguments } : {}),
        ...(card.inputArgumentsSource ? { inputArgumentsSource: card.inputArgumentsSource } : {}),
        ...(card.inputArgumentsNote ? { inputArgumentsNote: card.inputArgumentsNote } : {}),
        ...(card.executionUuid ? { executionUuid: card.executionUuid } : {}),
      };
      const toolCards = [...iteration.toolCards];
      toolCards[existingIndex] = merged;
      return {
        ...iteration,
        status: 'tool_calling',
        toolCards,
      };
    }
    return {
      ...iteration,
      status: 'tool_calling',
      toolCards: [...iteration.toolCards, card],
    };
  }, data);
}

/**
 * Client local tool dispatching：如果当前 iteration 已经有同 toolCallId 的卡，
 * 视为 stream 重连恢复，刷新元信息；否则新建一张。
 */
function upsertClientToolCard(process: ThinkingProcess, data: unknown): ThinkingProcess {
  // v3 client_tool_dispatching 的 payload schema 是 { call: { toolCallId, capabilityId,
  // argumentsPreview, ... }, ... }；v2 则是平平的。跟 normalizeClientToolCall 对齐，
  // 优先从 data.call 读，读不到再回取 data，避免拿不到 toolCallId 与 arguments。
  const raw: unknown = isRecord(data) && isRecord(data.call) ? data.call : data;

  const toolCallId = readString(raw, ['toolCallId', 'tool_call_id', 'callId', 'id']);
  if (!toolCallId) return appendToolCard(process, raw, 'dispatching');

  const lastIteration = process.iterations[process.iterations.length - 1];
  const existing = lastIteration?.toolCards.find((tool) => tool.toolCallId === toolCallId);

  if (!existing) return appendToolCard(process, raw, 'dispatching');

  // 合并 arguments：云端 tool_calling 事件可能不带 arguments，而 client_tool_dispatching
  // （客户端 capability 分发阶段）一定带完整参数。这里允许后者补充到同一张
  // ToolCard 上，避免 ThinkingTimeline 的 inputArguments 区没内容。
  let argsFromData: unknown;
  if (isRecord(raw)) {
    if (raw.argumentsPreview !== undefined) argsFromData = raw.argumentsPreview;
    else if (raw.arguments !== undefined) argsFromData = raw.arguments;
    else if (raw.input !== undefined && isRecord(raw.input) && Object.keys(raw.input as object).length > 0) argsFromData = raw.input;
    else if (raw.args !== undefined) argsFromData = raw.args;
  }
  const argsSource = readString(raw, ['argsSource']);
  const argsNote = readString(raw, ['argsNote']);
  const capabilityId = readString(raw, ['capabilityId']);

  return updateLastIteration(process, (iteration) =>
    updateToolCard(iteration, raw, (tool) => ({
      ...tool,
      clientToolStatus: 'dispatching',
      status: deriveToolCardStatus('dispatching'),
      ...(capabilityId ? { capabilityId } : {}),
      ...(argsFromData !== undefined ? { inputArguments: argsFromData } : {}),
      ...(argsSource ? { inputArgumentsSource: argsSource } : {}),
      ...(argsNote ? { inputArgumentsNote: argsNote } : {}),
    })), raw);
}

function updateClientToolStatus(
  process: ThinkingProcess,
  data: unknown,
  clientToolStatus: ClientToolStatus,
): ThinkingProcess {
  return updateLastIteration(process, (iteration) =>
    updateToolCard(iteration, data, (tool) => ({
      ...tool,
      clientToolStatus,
      status: deriveToolCardStatus(clientToolStatus),
    })), data);
}

function appendClientToolStream(
  process: ThinkingProcess,
  data: unknown,
  channel: 'stdout' | 'stderr',
): ThinkingProcess {
  const delta = readString(data, ['delta', 'chunk', 'text']);
  if (!delta) return process;
  return updateLastIteration(process, (iteration) =>
    updateToolCard(iteration, data, (tool) => ({
      ...tool,
      [channel]: (tool[channel] ?? '') + delta,
    })), data);
}

/**
 * 收到 client_tool_result_received：根据 result.status 翻终态。
 * outputPreview 当 string 直接写 resultContent，当 object 转 JSON 写 resultSummary。
 */
function finalizeClientToolCard(process: ThinkingProcess, data: unknown): ThinkingProcess {
  const rawStatus = readString(data, ['status', 'resultStatus']);
  const clientToolStatus: ClientToolStatus =
    rawStatus === 'success'
      ? 'completed'
      : rawStatus === 'failed' || rawStatus === 'denied' || rawStatus === 'timeout' || rawStatus === 'cancelled'
        ? (rawStatus as ClientToolStatus)
        : 'completed';

  return updateLastIteration(process, (iteration) =>
    updateToolCard(iteration, data, (tool) => {
      const previewString = readString(data, ['outputPreview', 'preview', 'result', 'content']);
      const previewSummary =
        previewString === undefined && isRecord(data) && data.outputPreview !== undefined
          ? safeStringify(data.outputPreview)
          : undefined;
      const errorMessage = readString(data, ['errorMessage', 'error']);
      // M1·F：local skill 的 outputPreview 是给云端 LLM 的完整 instructions（prompt），
      // 不该原样摊给用户。优先用 evidence.summary（如"技能 X 已就绪"）作卡片摘要；
      // 完整 instructions 仍保留在 resultContent，供折叠/调试展开。
      const evidenceSummary =
        isRecord(data) && isRecord(data.evidence)
          ? readString(data.evidence, ['summary'])
          : undefined;

      return {
        ...tool,
        clientToolStatus,
        status: deriveToolCardStatus(clientToolStatus),
        durationMs: readNumber(data, ['durationMs', 'duration']) ?? tool.durationMs,
        resultContent: previewString ?? tool.resultContent,
        resultSummary:
          evidenceSummary ?? previewSummary ?? errorMessage ?? tool.resultSummary,
      };
    }), data);
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : String(value);
  } catch {
    return String(value);
  }
}

function completeToolCard(process: ThinkingProcess, data: unknown, status: ToolCard['status']): ThinkingProcess {
  return updateLastIteration(process, (iteration) =>
    updateToolCard(iteration, data, (tool) => ({
      ...tool,
      status,
      durationMs: readNumber(data, ['durationMs', 'duration']) ?? tool.durationMs,
      resultSummary: readString(data, ['summary', 'resultSummary']) ?? tool.resultSummary,
      resultContent: readString(data, ['content', 'result', 'output']) ?? tool.resultContent,
    })), data);
}

function appendStep(process: ThinkingProcess, data: unknown): ThinkingProcess {
  return updateLastIteration(process, (iteration) =>
    updateToolCard(iteration, data, (tool) => ({
      ...tool,
      steps: [...tool.steps, createSkillStep(data, tool.steps.length + 1)],
    })), data);
}

function completeStep(process: ThinkingProcess, data: unknown, status: SkillStep['status']): ThinkingProcess {
  return updateLastIteration(process, (iteration) =>
    updateToolCard(iteration, data, (tool) => {
      const stepNumber = readNumber(data, ['step', 'stepIndex', 'index']);
      const stepIndex = stepNumber
        ? tool.steps.findIndex((item) => item.step === stepNumber)
        : tool.steps.length - 1;
      if (stepIndex < 0) return tool;

      return {
        ...tool,
        steps: tool.steps.map((step, index) =>
          index === stepIndex
            ? {
              ...step,
              status,
              durationMs: readNumber(data, ['durationMs', 'duration']) ?? step.durationMs,
              outputSummary: readString(data, ['summary', 'outputSummary']) ?? step.outputSummary,
              outputData: isRecord(data) && data.outputData !== undefined ? data.outputData : step.outputData,
            }
            : step,
        ),
      };
    }), data);
}

function setPendingConfirmation(
  process: ThinkingProcess,
  confirmation: PendingHumanConfirmation,
): ThinkingProcess {
  return {
    ...process,
    status: 'waiting_user',
    pendingHumanConfirmation: confirmation,
  };
}

function finishProcess(process: ThinkingProcess, status: ThinkingProcess['status'], data?: unknown): ThinkingProcess {
  return {
    ...process,
    status,
    totalDurationMs: readNumber(data, ['totalDurationMs', 'durationMs']) ?? process.totalDurationMs,
    totalIterations: readNumber(data, ['totalIterations', 'iterations']) ?? process.totalIterations,
    totalToolCalls: readNumber(data, ['totalToolCalls', 'toolCalls']) ?? process.totalToolCalls,
    iterations: process.iterations.map((iteration) => ({
      ...iteration,
      status: iteration.status === 'completed' ? iteration.status : 'completed',
      toolCards: iteration.toolCards.map((tool) => ({
        ...tool,
        status: tool.status === 'running' ? (status === 'error' ? 'error' : 'completed') : tool.status,
      })),
    })),
  };
}

export function applyThinkingEvent(
  current: ThinkingProcess | null | undefined,
  eventType: string,
  data: unknown,
): ThinkingProcess | null {
  const requiresExistingProcess = eventType === 'content_delta' ||
    eventType === 'role_content_delta' ||
    eventType === 'llm_delta' ||
    eventType === 'llm_response';
  const pendingConfirmation = normalizePendingHumanConfirmation(data);

  if (pendingConfirmation) {
    const process = current ?? createThinkingProcess();
    return setPendingConfirmation(process, pendingConfirmation);
  }

  if (!current && requiresExistingProcess) return null;
  const process = current ?? createThinkingProcess();

  switch (eventType) {
    case 'execution_created':
    case 'react_start':
      return {
        ...process,
        status: 'running',
        executionUuid: readString(data, ['executionUuid']) ?? process.executionUuid,
        maxIterations: readNumber(data, ['maxIterations']) ?? process.maxIterations,
        toolCount: readNumber(data, ['toolCount']) ?? process.toolCount,
        estimatedDurationMs: readNumber(data, ['estimatedDurationMs']) ?? process.estimatedDurationMs,
      };

    case 'iteration_start':
    case 'llm_calling': {
      const label = readString(data, ['label', 'message']);
      const executionUuid = readString(data, ['executionUuid']);
      const iteration = readNumber(data, ['iteration', 'round']);

      // 治本：复合 key 定位轮次
      if (executionUuid !== undefined && iteration !== undefined) {
        const idx = process.iterations.findIndex(
          (it) => it.executionUuid === executionUuid && it.iteration === iteration,
        );
        if (idx >= 0) {
          // 命中已有轮 = forwardByRun 重放：重置 thinkingContent 让后续 delta 重建，
          // toolCards 保留（由 toolCallId upsert 幂等），避免整轮重复。
          const iterations = [...process.iterations];
          iterations[idx] = {
            ...iterations[idx],
            thinkingContent: '',
            label: label ?? iterations[idx].label,
            status: 'thinking',
          };
          return { ...process, iterations };
        }
        const prevIterations = process.iterations.map((it) =>
          it.status === 'thinking' || it.status === 'tool_calling' ? { ...it, status: 'completed' as const } : it,
        );
        return {
          ...process,
          iterations: [
            ...prevIterations,
            { ...createIteration(iteration, label, executionUuid), status: 'thinking' },
          ],
        };
      }

      // 兜底（无复合 key）：上一轮已调过工具后开新一轮；否则只更新当前轮 label/status。
      if (shouldStartNewIteration(process)) {
        const last = process.iterations[process.iterations.length - 1];
        const prevIterations = process.iterations.map((it) =>
          it.status === 'thinking' || it.status === 'tool_calling' ? { ...it, status: 'completed' as const } : it,
        );
        return {
          ...process,
          iterations: [
            ...prevIterations,
            { ...createIteration(last.iteration + 1, label), status: 'thinking' },
          ],
        };
      }
      return updateLastIteration(process, (it) => ({
        ...it,
        label: label ?? it.label,
        status: 'thinking',
      }), data);
    }

    case 'content_delta':
    case 'role_content_delta':
    case 'thinking_delta':
    case 'llm_delta':
    case 'llm_response':
      return appendThinkingContent(process, data);

    case 'tool_calling':
    case 'tool_start':
    case 'skill_start':
      return appendToolCard(process, data);

    case 'tool_result':
    case 'tool_complete':
    case 'skill_complete':
      return completeToolCard(process, data, 'completed');

    case 'tool_error':
    case 'skill_error':
      return completeToolCard(process, data, 'error');

    case 'client_tool_dispatching':
    case 'client_tool_call':
    case 'client_tool_call.created':
      return upsertClientToolCard(process, data);

    case 'client_tool_acked':
      return updateClientToolStatus(process, data, 'acked');

    case 'client_tool_waiting_user_consent':
      return updateClientToolStatus(process, data, 'waiting_user_consent');

    case 'client_tool_running':
      return updateClientToolStatus(process, data, 'running');

    case 'client_tool_stdout_delta':
      return appendClientToolStream(process, data, 'stdout');

    case 'client_tool_stderr_delta':
      return appendClientToolStream(process, data, 'stderr');

    case 'client_tool_result_received':
      return finalizeClientToolCard(process, data);

    case 'agent_run_suspended':
    case 'stream_paused':
      return { ...process, status: 'waiting_user' };

    case 'agent_run_resuming':
      return { ...process, status: 'running' };

    case 'step_start':
      return appendStep(process, data);

    case 'step_complete':
      return completeStep(process, data, 'completed');

    case 'step_error':
      return completeStep(process, data, 'error');

    case 'complete':
    case 'chat_complete':
      return finishProcess(process, 'completed', data);

    case 'error':
      return finishProcess(process, 'error', data);

    default:
      return current ?? null;
  }
}
