import { createRuntimePipeline } from '@peer-agent/runtime-sdk';

export function createDesktopAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export function createDesktopPipelineEventAdapter({
  emitRuntimeEvent = null,
  state = { sessionStarted: false },
} = {}) {
  return {
    emit(event) {
      if (typeof emitRuntimeEvent !== 'function') return null;
      // message.completed/runtime.error 仍由现有 webContents adapter 携带完整 usage、
      // lifetimeUsage 与 Desktop 错误码发出；Pipeline 迁移期不重复发终态。
      if (event?.type === 'message.completed' || event?.type === 'runtime.error') return null;
      if (event?.type === 'session.started') {
        if (state.sessionStarted) return null;
        state.sessionStarted = true;
      }
      return emitRuntimeEvent(event);
    },
  };
}

export async function runDesktopRuntimePipeline({
  sessionId,
  streamId,
  conversationId = null,
  mode = 'chat',
  providerId = null,
  modelId = null,
  maxTurns,
  maxToolCalls,
  sliceToolCalls,
  yieldAtTurnLimit,
  shouldYield,
  maxToolBatchCalls,
  budgetGuard = null,
  signal,
  model,
  tools,
  lifecycle = null,
  emitRuntimeEvent = null,
  eventState = undefined,
}) {
  let modelFailure = null;
  const pipeline = createRuntimePipeline({
    model: { ...model, ...(typeof model.checkpoint === 'function' ? { async checkpoint(state, executions, context) {
      try { return await model.checkpoint(state, executions, context); }
      catch (cause) {
        const error = new Error('checkpoint_persistence_failed', { cause });
        error.providerRecovery = { kind: 'execution_outcome_unknown', phase: 'request', retryable: false };
        modelFailure = error;
        throw error;
      }
    } } : {}), async runTurn(state, context) {
      try { return await model.runTurn(state, context); }
      catch (error) { modelFailure = error; throw error; }
    } },
    tools: { ...tools,
      async execute(call, context) {
        try { budgetGuard?.beforeTool(call); } catch (error) { return (tools.notExecuted || notExecuted)(call, error.message); }
        return tools.execute(call, context);
      },
      notExecuted: tools.notExecuted || notExecuted,
    },
    ...(lifecycle ? { lifecycle } : {}),
    events: createDesktopPipelineEventAdapter({
      emitRuntimeEvent,
      state: eventState,
    }),
    defaultMaxTurns: maxTurns,
  });
  const result = await pipeline.run({
    sessionId: sessionId || streamId,
    streamId,
    ...(conversationId ? { conversationId } : {}),
    mode,
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { model: modelId } : {}),
    input: null,
    maxTurns,
    maxToolCalls, sliceToolCalls, yieldAtTurnLimit, shouldYield, maxToolBatchCalls,
  }, { signal });

  // Desktop 外层已经以异常驱动 chat:stream:error / aborted 与资源清理；公共
  // Pipeline 使用结构化终态，Adapter 在宿主边界恢复既有语义，不能把 failed 当成功返回，
  // 否则外层只会看到“无终态结果”并覆盖真实错误，甚至遗漏 renderer 收口事件。
  if (result.status === 'cancelled') throw createDesktopAbortError();
  if (result.status === 'failed') {
    const error = new Error(result.reason || 'runtime_pipeline_failed');
    if (modelFailure?.providerRecovery) error.providerRecovery = modelFailure.providerRecovery;
    throw error;
  }
  return result;
}

export function createNotExecutedToolCall({ call, reason, webContents, streamId }) {
  const result = notExecuted(call, reason);
  webContents?.send?.('chat:stream:tool-call', { streamId, toolCallId: call.toolCallId, tool: call.name, args: call.arguments });
  webContents?.send?.('chat:stream:tool-result', { streamId, toolCallId: call.toolCallId, result: result.result.output });
  return result;
}
function notExecuted(call, reason) {
  return { call, result: { output: JSON.stringify({ ok: false, status: 'not_executed', error: reason }),
    isError: true, error: reason }, terminal: true, terminalReason: reason };
}
