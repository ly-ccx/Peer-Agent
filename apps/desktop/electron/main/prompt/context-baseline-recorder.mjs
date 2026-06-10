import { buildSystemContext } from '../llm-prompts.mjs';

export function createContextBaselineRecorder({
  promptSnapshotStore = null,
  getWorkspacePath = () => null,
  logger = console,
} = {}) {
  function recordSystemContextBaseline({
    reason,
    provider = null,
    conversationId = null,
    streamId = null,
    mode = 'chat',
    effort = null,
    configInstructions = [],
  } = {}) {
    if (!promptSnapshotStore?.recordBaseline) return null;

    const workspacePath = getWorkspacePath?.() ?? null;
    const providerFamily = provider?.provider ?? null;
    const model = provider?.model ?? null;
    const providerId = provider?.id ?? provider?.providerId ?? null;

    try {
      const context = buildSystemContext(workspacePath, {
        conversationId,
        configInstructions,
        effort,
        mode,
        provider: providerFamily,
        model,
      });
      return promptSnapshotStore.recordBaseline(context, {
        streamId,
        conversationId,
        effort,
        provider: providerFamily,
        providerId,
        model,
        mode,
        baselineReason: reason,
      });
    } catch (error) {
      logger?.warn?.('[context-baseline] failed to record context baseline:', error?.message || error);
      return null;
    }
  }

  function recordProviderBaseline({
    reason = 'model_switch',
    provider = null,
    conversationId = null,
    streamId = null,
    mode = 'chat',
    effort = null,
  } = {}) {
    if (!provider || !promptSnapshotStore?.recordBaseline) return null;

    return recordSystemContextBaseline({
      reason,
      provider,
      conversationId,
      streamId,
      mode,
      effort,
    });
  }

  function recordConfiguredInstructionsBaseline({
    reason = 'instruction_change',
    instructions = '',
    provider = null,
    conversationId = null,
    streamId = null,
    mode = 'chat',
    effort = null,
  } = {}) {
    const content = typeof instructions === 'string' ? instructions.trim() : '';
    const configInstructions = content
      ? [{
          id: 'settings.systemInstructions',
          title: 'System Instructions',
          content,
          priority: 0,
          source: 'settings.systemInstructions',
        }]
      : [];

    return recordSystemContextBaseline({
      reason,
      provider,
      conversationId,
      streamId,
      mode,
      effort,
      configInstructions,
    });
  }

  return {
    recordProviderBaseline,
    recordConfiguredInstructionsBaseline,
  };
}
