import {
  buildQoderCliPrompt,
  callQoderCliPrompt,
} from '../provider-adapters/qoder-cli-adapter.mjs';
import { createAgentLoopKernel } from './agent-loop-kernel.mjs';
import { computeContextInfo } from './compaction-coordinator.mjs';

function makeAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export async function agentLoopQoder({
  model = 'Auto',
  systemPrompt,
  messages,
  webContents,
  streamId,
  signal,
  contextWindow,
  agentProgress = null,
  workspacePath,
  maxOutputTokens = 0,
}) {
  const loop = createAgentLoopKernel({
    webContents,
    streamId,
    onRound: agentProgress?.onRound,
    getContextInfo: () => computeContextInfo({
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      contextWindow,
      tools: [],
    }),
  });

  const prompt = buildQoderCliPrompt({
    systemPrompt,
    messages,
    workspacePath,
  });
  const result = await callQoderCliPrompt({
    prompt,
    model,
    cwd: workspacePath || process.cwd(),
    contextWindow,
    maxOutputTokens,
    signal,
  });

  if (result.aborted || signal?.aborted) throw makeAbortError();
  loop.addUsage(null);
  if (!result.ok) {
    loop.sendError(result.errorText || 'qoder_cli_error');
    return;
  }

  const content = String(result.content || '').trim();
  if (!content) {
    loop.sendError('qoder_cli_empty_response');
    return;
  }
  webContents?.send?.('chat:stream:delta', { streamId, content });
  loop.sendDone();
}
