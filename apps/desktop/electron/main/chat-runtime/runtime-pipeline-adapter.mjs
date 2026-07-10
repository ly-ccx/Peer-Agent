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
  signal,
  model,
  tools,
  emitRuntimeEvent = null,
  eventState = undefined,
}) {
  const pipeline = createRuntimePipeline({
    model,
    tools,
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
  }, { signal });

  // Desktop 外层已经以 AbortError 驱动 chat:stream:aborted 与资源清理；公共
  // Pipeline 使用结构化 cancelled 结果，Adapter 在宿主边界恢复既有语义。
  if (result.status === 'cancelled') throw createDesktopAbortError();
  return result;
}
