import type { IterationNode, ThinkingProcess, ToolCard } from '@zeus-atlas/protocol';

/**
 * 历史 thinking_process.stepsData → 前端 ThinkingProcess.iterations 归一化。
 *
 * 背景：
 * - 流式路径下，前端 thinking-reducer 根据 SSE 事件实时拼出 ThinkingProcess
 *   （iterations + toolCards 扁平结构）
 * - 历史路径下，后端 `getFullThinkingProcess` 返回 `{ process, stepsData }`，
 *   stepsData 是 ReAct 引擎的「step → iteration → tool」二级嵌套结构
 * - 切换会话后 UI 拿到的是后端结构，前端 ThinkingTimeline 读 iterations 为
 *   空 → 显示「暂无可展开的思考或工具事件」（用户感知为 thinking 消失）
 *
 * 转换规则：
 * - 把所有 step.iterations 按顺序拍平
 * - 每个 `type='thinking'` 节点开启一个新 IterationNode（thinkingContent =
 *   该节点 content；silent=true 时为空字符串）
 * - 后续 `type='tool_call'` 归到当前 IterationNode 的 toolCards
 * - `type='observation'` 视为最近一个 toolCard 的结果（合并 resultSummary）
 * - 若开头就是 tool_call（无 thinking 引导），自动起一个空 thinkingContent 的
 *   IterationNode 兜底
 */

interface BackendStepIteration {
  iterationIndex?: number;
  type?: 'thinking' | 'tool_call' | 'observation' | string;
  content?: string;
  silent?: boolean;
  toolCallId?: string;
  toolName?: string;
  toolDisplayName?: string;
  toolType?: string;
  skillId?: string;
  skillName?: string;
  executionUuid?: string;
  result?: unknown;
}

interface BackendThinkingStep {
  stepIndex?: number;
  stepName?: string;
  status?: 'pending' | 'running' | 'completed' | 'failed';
  iterations?: BackendStepIteration[];
}

export interface BackendThinkingStepsData {
  steps?: BackendThinkingStep[];
  totalIterations?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const readString = (value: unknown, keys: readonly string[]): string | undefined => {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const v = value[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
};

const summarizeResult = (result: unknown): string | undefined => {
  if (result == null) return undefined;
  if (typeof result === 'string') {
    return result.length > 200 ? `${result.slice(0, 200)}…` : result;
  }
  try {
    const json = JSON.stringify(result);
    if (!json) return undefined;
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return undefined;
  }
};

function toToolCard(it: BackendStepIteration): ToolCard {
  const id = it.toolCallId ?? it.executionUuid ?? `tool_${Date.now()}_${Math.random()}`;
  return {
    toolCallId: id,
    toolId: it.toolName ?? it.toolCallId ?? 'unknown_tool',
    displayName: it.toolDisplayName ?? it.toolName ?? it.skillName ?? 'tool',
    status: 'completed',
    executionUuid: it.executionUuid,
    steps: [],
    resultSummary: summarizeResult(it.result),
  };
}

/**
 * 把后端 stepsData 转换为前端 IterationNode[]。
 */
export function iterationsFromBackendStepsData(
  stepsData: BackendThinkingStepsData | null | undefined,
): IterationNode[] {
  if (!stepsData || !Array.isArray(stepsData.steps)) return [];

  const flat: BackendStepIteration[] = [];
  for (const step of stepsData.steps) {
    if (!step || !Array.isArray(step.iterations)) continue;
    for (const it of step.iterations) {
      if (isRecord(it)) flat.push(it as BackendStepIteration);
    }
  }

  if (flat.length === 0) return [];

  const iterations: Array<{
    iteration: number;
    thinkingContent: string;
    toolCards: ToolCard[];
  }> = [];

  const openIteration = (content: string) => {
    iterations.push({
      iteration: iterations.length + 1,
      thinkingContent: content,
      toolCards: [],
    });
  };

  for (const it of flat) {
    const type = it.type ?? 'thinking';
    if (type === 'thinking') {
      const content = it.silent ? '' : it.content ?? '';
      openIteration(content);
      continue;
    }

    // tool_call / observation 都需要挂到当前 iteration；如果没有就先兜底起一个
    if (iterations.length === 0) openIteration('');
    const current = iterations[iterations.length - 1];

    if (type === 'tool_call') {
      current.toolCards.push(toToolCard(it));
      continue;
    }

    if (type === 'observation') {
      const lastCard = current.toolCards[current.toolCards.length - 1];
      if (lastCard) {
        const summary = readString(it, ['content']) ?? summarizeResult(it.result);
        if (summary) {
          current.toolCards[current.toolCards.length - 1] = {
            ...lastCard,
            resultSummary: lastCard.resultSummary ?? summary,
          };
        }
      }
    }
  }

  return iterations.map((node) => ({
    iteration: node.iteration,
    thinkingContent: node.thinkingContent,
    toolCards: node.toolCards,
    status: 'completed',
  }));
}

/**
 * 把后端 `{ process, stepsData }` 合并成前端可直接渲染的 ThinkingProcess。
 *
 * `process` 提供顶层元数据（processUuid/executionUuid/status/totals），
 * `stepsData` 提供 iterations 内容。两者都可缺省——给出尽可能合理的兜底。
 */
export function hydrateThinkingProcessFromBackend(payload: {
  process?: Record<string, unknown> | null;
  stepsData?: BackendThinkingStepsData | null;
}): ThinkingProcess {
  const process = payload.process ?? {};
  const iterations = iterationsFromBackendStepsData(payload.stepsData);

  const rawStatus =
    typeof process.status === 'string' ? process.status : 'completed';
  const status: ThinkingProcess['status'] =
    rawStatus === 'running' ||
    rawStatus === 'error' ||
    rawStatus === 'waiting' ||
    rawStatus === 'waiting_user'
      ? rawStatus
      : 'completed';

  return {
    expanded: true,
    iterations,
    maxIterations:
      typeof process.totalSteps === 'number' ? process.totalSteps : iterations.length,
    toolCount:
      typeof process.totalToolCalls === 'number' ? process.totalToolCalls : 0,
    totalToolCalls:
      typeof process.totalToolCalls === 'number' ? process.totalToolCalls : undefined,
    totalIterations:
      typeof process.totalLlmCalls === 'number' ? process.totalLlmCalls : undefined,
    totalDurationMs:
      typeof process.durationMs === 'number' ? process.durationMs : undefined,
    processUuid:
      typeof process.processUuid === 'string' ? process.processUuid : undefined,
    executionUuid:
      typeof process.executionUuid === 'string' ? process.executionUuid : undefined,
    status,
  };
}
