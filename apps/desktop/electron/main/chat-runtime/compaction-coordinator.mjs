import {
  COMPACTION_CONFIG,
  compactIfNeeded,
  estimateTokensFromMessages,
  microcompactMessagesForContext,
} from '../context-compactor.mjs';

export function isPromptTooLongResponse(status, text) {
  if (status === 413) return true;
  const value = String(text || '').toLowerCase();
  return (
    value.includes('prompt_too_long') ||
    value.includes('context_length_exceeded') ||
    value.includes('maximum context length') ||
    value.includes('too many tokens') ||
    value.includes('token limit')
  );
}

export function applyMicrocompaction(messages, { log = console.log } = {}) {
  const result = microcompactMessagesForContext(messages);
  if (result.stats.compactedCount > 0) {
    log(
      `[llm-chat] Microcompacted ${result.stats.compactedCount} historical messages (${result.stats.savedChars} chars saved)`,
    );
  }
  return result;
}

function shouldShowCompactionStart(messages, contextWindow) {
  if (!contextWindow) return false;
  return estimateTokensFromMessages(messages) > contextWindow * COMPACTION_CONFIG.triggerRatio;
}

async function persistAndNotifyCompaction({
  persistCompaction,
  conversationId,
  compactResult,
  streamId,
  webContents,
  emergency = false,
}) {
  if (persistCompaction && conversationId) {
    await persistCompaction({ conversationId, compactResult, preservePendingAssistant: true });
  }
  webContents.send('chat:compaction', { streamId, stage: 'done', emergency, ...compactResult.notification });
}

export async function runCompactionCheck({
  messages,
  systemPrompt,
  contextWindow,
  providerConfig,
  signal,
  persistCompaction,
  conversationId,
  streamId,
  webContents,
  emergency = false,
  force = false,
  continuityContext = [],
}) {
  if (!contextWindow && !force) {
    return { compacted: false, messages };
  }

  const showStart = emergency || shouldShowCompactionStart(messages, contextWindow);
  if (showStart) {
    webContents.send('chat:compaction', { streamId, stage: 'start', emergency });
  }

  const compactResult = await compactIfNeeded({
    messages,
    systemPrompt,
    contextWindow,
    providerConfig,
    signal,
    force,
    continuityContext,
  });

  if (compactResult.compacted) {
    await persistAndNotifyCompaction({
      persistCompaction,
      conversationId,
      compactResult,
      streamId,
      webContents,
      emergency,
    });
    return { compacted: true, messages: compactResult.messages, compactResult };
  }

  if (showStart) {
    webContents.send('chat:compaction', { streamId, stage: 'idle', emergency });
  }
  return { compacted: false, messages };
}
