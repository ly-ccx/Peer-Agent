import { sendOpenAIChatStream } from './provider-adapters/openai-chat-adapter.mjs';
import { sendAnthropicMessagesStream } from './provider-adapters/anthropic-messages-adapter.mjs';
import { sendGeminiStream } from './provider-adapters/gemini-adapter.mjs';
import { sendQoderPrivateStream } from './provider-adapters/qoder-private-adapter.mjs';
import { encodeOpenAIResponsesRequest } from './provider-encoders/responses-encoder.mjs';
import { consumeResponsesStream } from './chatgpt-responses-provider.ts';

/** One bounded, tool-free inference using existing encoders and stream consumers. */
export function createProviderTextInference({ resolveCredential, resolveChannel, fetchImpl }) {
  return async function infer({ route, messages, signal, maxOutputTokens, onUsage }) {
    const provider = route.provider;
    const credential = await resolveCredential(provider, signal);
    if (signal.aborted) throw new Error('CANCELLED');
    const channel = resolveChannel({ ...provider, apiKey: credential.apiKey,
      accountId: credential.accountId, oauthProjectId: provider.oauthProjectId || credential.oauthProjectId });
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    let chars = 0, forbidden = false, usage = null;
    function eventSink(name, payload) {
      if (name === 'chat:stream:usage') { usage = payload.usage; onUsage?.(usage); }
      if (name === 'chat:stream:delta' || name === 'chat:stream:thinking') chars += String(payload.content ?? '').length;
      if (name === 'chat:stream:tool-progress') forbidden = true;
      if (chars > 4096 || forbidden) controller.abort();
    }
    const fetchOnce = (url, init) => fetchImpl(url, { ...init, signal: controller.signal });
    const common = { ...channel, apiKey: credential.apiKey, model: provider.model, messages,
      tools: [], signal: controller.signal, maxOutputTokens, eventSink, tracePrivacy: 'metadata_only',
      streamId: undefined, effort: route.selection?.reasoningEffort ?? 'off',
      fetchImpl: fetchOnce, fetchWithRecovery: fetchOnce };
    try {
      let result;
      if (channel.wire === 'openai-chat') result = await sendOpenAIChatStream(common);
      else if (channel.wire === 'anthropic-messages') {
        const system = messages.filter(row => row.role === 'system').map(row => row.content).join('\n\n');
        result = await sendAnthropicMessagesStream({ ...common, system,
          messages: messages.filter(row => row.role !== 'system') });
      } else if (channel.wire === 'gemini') result = await sendGeminiStream({ ...common,
        authMethod: channel.authMethod, projectId: channel.oauthProjectId });
      else if (channel.wire === 'qoder-private') result = await sendQoderPrivateStream({ ...common,
        modelOptions: provider.modelOptions, modelOptionValues: provider.modelOptionValues,
        maxQueueRetries: 0, transientRetryDelaysMs: [], duplicateRetryDelaysMs: [], queueBudgetMs: 0 });
      else if (channel.wire === 'openai-responses') {
        const body = encodeOpenAIResponsesRequest({ ...common,
          omitMaxOutputTokens: channel.authMethod === 'oauth_chatgpt' });
        // Subscription endpoints may reject output-limit fields; the abortable,
        // bounded consumer and request deadline still bound local processing.
        const response = await fetchOnce(channel.endpoint, { method: 'POST', headers: channel.headers, body: JSON.stringify(body) });
        if (!response.ok) return { ok: false, content: '', toolCalls: [], usage };
        const value = await consumeResponsesStream(response, { model: provider.model,
          messages, tools: [], signal: controller.signal, onEvent: event => {
            if (event.type === 'usage') eventSink('chat:stream:usage', { usage: event.usage });
            if (event.type === 'text.delta' || event.type === 'reasoning.delta') eventSink('chat:stream:delta', { content: event.content });
            if (event.type === 'tool_call.delta' || event.type === 'tool_call.completed') { forbidden = true; controller.abort(); }
          } });
        result = { ok: true, ...value, streamUsage: value.usage };
      } else return { ok: false, content: '', toolCalls: [], usage };
      const toolCalls = result.toolCalls ?? result.toolUseBlocks ?? [];
      usage = result.streamUsage ?? usage;
      if (usage) onUsage?.(usage);
      return { ok: result.ok === true && !forbidden, content: result.content ?? result.textContent ?? '', toolCalls, usage };
    } finally { signal.removeEventListener('abort', abort); }
  };
}
