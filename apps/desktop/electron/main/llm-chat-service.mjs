import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  COMPACTION_CONFIG,
  compactIfNeeded,
  estimateTokensFromMessages,
  microcompactMessagesForContext,
} from './context-compactor.mjs';
import { getDataHome } from './data-store.mjs';
import { createShellArtifactStore } from './runtime-gateway/shell-artifacts.mjs';

const activeStreams = new Map();

const OPENAI_REASONING_EFFORT = { low: 'low', default: 'medium', high: 'high' };
const ANTHROPIC_THINKING_BUDGET = { low: 4096, default: 10240, high: 32768 };
const MAX_TOOL_CONTEXT_CHARS = 4_000;
const shellArtifactStore = createShellArtifactStore({ userDataPath: getDataHome() });

const TOOLS_OPENAI = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a bash command on the local machine. Use for file operations, git, build tools, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates the file if it does not exist.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path' },
          content: { type: 'string', description: 'The content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

const TOOLS_ANTHROPIC = TOOLS_OPENAI.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters,
}));

function buildSystemPrompt(workspacePath) {
  const parts = ['You are Peer Agent, a helpful local AI assistant with access to the user\'s machine.'];
  if (workspacePath) {
    parts.push(`Current workspace: ${workspacePath}`);
    parts.push('Use relative paths when possible. You can read files, execute commands, and write files in this workspace.');
  }
  return parts.join('\n');
}

function previewText(value, maxChars = MAX_TOOL_CONTEXT_CHARS) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return { text, truncated: false };
  const headChars = Math.max(1_000, Math.floor(maxChars * 0.55));
  const tailChars = Math.max(800, maxChars - headChars - 80);
  return {
    text: `${text.slice(0, headChars)}\n...[context preview truncated: ${text.length} chars]...\n${text.slice(-tailChars)}`,
    truncated: true,
  };
}

function quoteShellPath(filePath) {
  return `"${String(filePath ?? '').replace(/(["\\$`])/g, '\\$1')}"`;
}

function lineCount(value) {
  const text = String(value ?? '');
  return text ? text.split('\n').length : 0;
}

function formatContextResult(payload) {
  return JSON.stringify(payload, null, 2);
}

function isPromptTooLongResponse(status, text) {
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

function shouldShowCompactionStart(messages, contextWindow) {
  if (!contextWindow) return false;
  return estimateTokensFromMessages(messages) > contextWindow * COMPACTION_CONFIG.triggerRatio;
}

function hasContent(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function isEmptyAssistantMessage(message) {
  return (
    message?.role === 'assistant' &&
    !message?.tool_calls?.length &&
    !hasContent(message?.content)
  );
}

export function sanitizeApiMessages(messages) {
  return messages.filter((message) => {
    if (!message || typeof message !== 'object') return false;
    if (isEmptyAssistantMessage(message)) return false;
    if (message.role === 'system') return hasContent(message.content);
    if (message.role === 'user') return hasContent(message.content);
    if (message.role === 'assistant') return hasContent(message.content) || Boolean(message.tool_calls?.length);
    if (message.role === 'tool') return hasContent(message.content);
    return false;
  });
}

async function materializeShellOutput({ command, cwd, stdout, stderr, exitCode, status }) {
  const taskId = `llm_shell_${randomUUID()}`;
  const now = new Date().toISOString();
  const artifact = await shellArtifactStore.writeTaskArtifacts({
    taskId,
    toolCallId: taskId,
    command,
    cwd,
    stdout,
    stderr,
    classification: {
      category: 'inline_llm_tool',
      riskLevel: 'L4_privileged',
      dataLevel: 'D2_sensitive',
      command,
      cwd,
    },
    startedAt: now,
    completedAt: now,
  });
  const stdoutPreview = previewText(stdout);
  const stderrPreview = previewText(stderr);
  return {
    success: status === 'success',
    output: formatContextResult({
      kind: 'local_tool_result_ref',
      tool: 'bash',
      command,
      cwd,
      status,
      exitCode,
      stdoutPath: artifact.stdoutPath,
      stderrPath: artifact.stderrPath,
      metadataPath: artifact.metadataPath,
      artifactRef: artifact.artifactRef,
      artifactRefs: artifact.artifactRefs,
      stdoutChars: String(stdout ?? '').length,
      stderrChars: String(stderr ?? '').length,
      stdoutLines: lineCount(stdout),
      stderrLines: lineCount(stderr),
      stdoutPreview: stdoutPreview.text || null,
      stderrPreview: stderrPreview.text || null,
      contextPreviewTruncated: stdoutPreview.truncated || stderrPreview.truncated,
      suggestedRetrieval: [
        `rg -n "FAIL|Error|error|failed|Expected|panic" ${quoteShellPath(artifact.stdoutPath)}`,
        `tail -n 120 ${quoteShellPath(artifact.stdoutPath)}`,
        ...(status === 'success' ? [] : [`sed -n '1,160p' ${quoteShellPath(artifact.stderrPath)}`]),
      ],
    }),
  };
}

function materializeFileRead({ filePath, content }) {
  const preview = previewText(content);
  return {
    success: true,
    output: formatContextResult({
      kind: 'local_file_ref',
      tool: 'read_file',
      path: filePath,
      chars: content.length,
      lines: lineCount(content),
      preview: preview.text,
      contextPreviewTruncated: preview.truncated,
      suggestedRetrieval: [
        `sed -n '1,160p' ${quoteShellPath(filePath)}`,
        `rg -n "<pattern>" ${quoteShellPath(filePath)}`,
      ],
    }),
  };
}

export async function executeTool(name, args, workspacePath) {
  const cwd = workspacePath || process.cwd();
  try {
    if (name === 'bash') {
      const output = execSync(args.command, { cwd, timeout: 30000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
      return await materializeShellOutput({
        command: args.command,
        cwd,
        stdout: output,
        stderr: '',
        exitCode: 0,
        status: 'success',
      });
    }
    if (name === 'read_file') {
      const filePath = args.path.startsWith('/') ? args.path : `${cwd}/${args.path}`;
      if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
      const content = readFileSync(filePath, 'utf8');
      return materializeFileRead({ filePath, content });
    }
    if (name === 'write_file') {
      const filePath = args.path.startsWith('/') ? args.path : `${cwd}/${args.path}`;
      writeFileSync(filePath, args.content, 'utf8');
      return { success: true, output: `Written ${args.content.length} bytes to ${filePath}` };
    }
    return { success: false, error: `Unknown tool: ${name}` };
  } catch (err) {
    if (name === 'bash') {
      return await materializeShellOutput({
        command: args.command,
        cwd,
        stdout: err?.stdout?.toString?.() ?? '',
        stderr: err?.stderr?.toString?.() || err?.message || 'execution failed',
        exitCode: typeof err?.status === 'number' ? err.status : null,
        status: 'failed',
      });
    }
    return { success: false, error: err?.message || 'execution failed', stderr: err?.stderr?.slice?.(0, 4000) };
  }
}

export function createLlmChatService({ llmConfigStore, persistCompaction = null }) {
  function setWorkspacePath(wsPath) { activeWorkspacePath = wsPath; }

  function getDefaultProvider() {
    const providers = llmConfigStore.listProviders();
    return providers.find((p) => p.isDefault && p.apiKeyConfigured) || providers.find((p) => p.apiKeyConfigured) || null;
  }

  async function sendMessage({ messages, webContents, streamId, effort = 'default', conversationId = null }) {
    const provider = getDefaultProvider();
    if (!provider) {
      webContents.send('chat:stream:error', { streamId, error: 'no_provider_configured' });
      return;
    }

    const apiKey = llmConfigStore.getDecryptedApiKey(provider.id);
    if (!apiKey) {
      webContents.send('chat:stream:error', { streamId, error: 'api_key_not_found' });
      return;
    }

    const controller = new AbortController();
    activeStreams.set(streamId, { controller, webContents });

    const systemPrompt = buildSystemPrompt(activeWorkspacePath);

    const contextWindow = provider.contextWindow || 0;

    try {
      if (provider.provider === 'anthropic') {
        await agentLoopAnthropic({ baseUrl: provider.baseUrl, apiKey, model: provider.model, systemPrompt, messages, webContents, streamId, signal: controller.signal, effort, contextWindow, conversationId, persistCompaction });
      } else {
        await agentLoopOpenAI({ baseUrl: provider.baseUrl, apiKey, model: provider.model, systemPrompt, messages, webContents, streamId, signal: controller.signal, effort, contextWindow, conversationId, persistCompaction });
      }
    } catch (err) {
      console.error('[llm-chat] error:', err);
      if (err?.name !== 'AbortError') {
        webContents.send('chat:stream:error', { streamId, error: err?.message || 'stream_failed' });
      }
    } finally {
      activeStreams.delete(streamId);
    }
  }

  function abort(streamId) {
    const active = activeStreams.get(streamId);
    if (!active) return { aborted: false };
    active.controller.abort();
    active.webContents.send('chat:stream:aborted', { streamId });
    activeStreams.delete(streamId);
    return { aborted: true };
  }

  return { sendMessage, abort, setWorkspacePath };
}

// ── OpenAI agent loop ──

async function agentLoopOpenAI({ baseUrl, apiKey, model, systemPrompt, messages, webContents, streamId, signal, effort, contextWindow, conversationId, persistCompaction }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let apiMessages = sanitizeApiMessages([{ role: 'system', content: systemPrompt }, ...messages]);
  const usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  const providerConfig = { provider: 'openai', baseUrl, apiKey, model };

  for (let turn = 0; turn < 20; turn++) {
    const microcompactResult = microcompactMessagesForContext(apiMessages);
    if (microcompactResult.stats.compactedCount > 0) {
      apiMessages = microcompactResult.messages;
      console.log(
        `[llm-chat] Microcompacted ${microcompactResult.stats.compactedCount} historical messages (${microcompactResult.stats.savedChars} chars saved)`,
      );
    }

    // Layer 1: 每轮检查是否需要压缩
    if (contextWindow) {
      const showCompactionStart = shouldShowCompactionStart(apiMessages, contextWindow);
      if (showCompactionStart) {
        webContents.send('chat:compaction', { streamId, stage: 'start' });
      }
      const compactResult = await compactIfNeeded({
        messages: apiMessages,
        systemPrompt,
        contextWindow,
        providerConfig,
        signal,
      });
      if (compactResult.compacted) {
        apiMessages = compactResult.messages;
        await persistAndNotifyCompaction({
          persistCompaction,
          conversationId,
          compactResult,
          streamId,
          webContents,
        });
      } else if (showCompactionStart) {
        webContents.send('chat:compaction', { streamId, stage: 'idle' });
      }
    }
    apiMessages = sanitizeApiMessages(apiMessages);
    const body = { model, messages: apiMessages, stream: true, stream_options: { include_usage: true }, tools: TOOLS_OPENAI };
    if (effort && effort !== 'default') body.reasoning_effort = OPENAI_REASONING_EFFORT[effort] ?? 'medium';

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (isPromptTooLongResponse(res.status, text)) {
        webContents.send('chat:compaction', { streamId, stage: 'start', emergency: true });
        const compactResult = await compactIfNeeded({
          messages: apiMessages,
          systemPrompt,
          contextWindow,
          providerConfig: null,
          signal,
          force: true,
        });
        if (compactResult.compacted) {
          apiMessages = compactResult.messages;
          await persistAndNotifyCompaction({
            persistCompaction,
            conversationId,
            compactResult,
            streamId,
            webContents,
            emergency: true,
          });
          continue;
        }
        webContents.send('chat:compaction', { streamId, stage: 'idle', emergency: true });
      }
      webContents.send('chat:stream:error', { streamId, error: `HTTP ${res.status}: ${text.slice(0, 300)}` });
      return;
    }

    const { content, toolCalls, streamUsage } = await consumeOpenAIStream(res, webContents, streamId);
    if (streamUsage) {
      usage.inputTokens += streamUsage.inputTokens || 0;
      usage.outputTokens += streamUsage.outputTokens || 0;
      usage.cacheWriteTokens += streamUsage.cacheWriteTokens || 0;
      usage.cacheReadTokens += streamUsage.cacheReadTokens || 0;
    }

    if (!toolCalls.length) {
      webContents.send('chat:stream:done', { streamId, usage });
      return;
    }

    apiMessages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })) });

    for (const tc of toolCalls) {
      const args = safeParseJson(tc.arguments);
      webContents.send('chat:stream:tool-call', { streamId, tool: tc.name, args, toolCallId: tc.id });
      const result = await executeTool(tc.name, args, activeWorkspacePath);
      const output = result.success ? result.output : `Error: ${result.error}${result.stderr ? '\n' + result.stderr : ''}`;
      webContents.send('chat:stream:tool-result', { streamId, toolCallId: tc.id, result: output.slice(0, 4000) });
      apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: output });
    }
  }

  webContents.send('chat:stream:done', { streamId, usage });
}

let activeWorkspacePath = null;

async function consumeOpenAIStream(res, webContents, streamId) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = [];
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6);
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          webContents.send('chat:stream:delta', { streamId, content: delta.content });
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: '', name: '', arguments: '' };
            if (tc.id) toolCalls[tc.index].id = tc.id;
            if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
            if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
          }
        }
        if (parsed.usage) {
          const u = parsed.usage;
          const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
          usage = {
            inputTokens: u.prompt_tokens ?? 0,
            outputTokens: u.completion_tokens ?? 0,
            cacheReadTokens: cachedTokens,
            cacheWriteTokens: 0,
          };
          webContents.send('chat:stream:usage', { streamId, usage });
        }
      } catch { /* skip */ }
    }
  }

  return { content, toolCalls: toolCalls.filter(Boolean), streamUsage: usage };
}

// ── Anthropic agent loop ──

async function agentLoopAnthropic({ baseUrl, apiKey, model, systemPrompt, messages, webContents, streamId, signal, effort, contextWindow, conversationId, persistCompaction }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
  let effectiveSystem = systemPrompt;
  let apiMessages = sanitizeApiMessages(messages);
  const usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  const providerConfig = { provider: 'anthropic', baseUrl, apiKey, model };

  for (let turn = 0; turn < 20; turn++) {
    const microcompactResult = microcompactMessagesForContext(apiMessages);
    if (microcompactResult.stats.compactedCount > 0) {
      apiMessages = microcompactResult.messages;
      console.log(
        `[llm-chat] Microcompacted ${microcompactResult.stats.compactedCount} historical messages (${microcompactResult.stats.savedChars} chars saved)`,
      );
    }

    // Layer 1: 每轮检查是否需要压缩
    if (contextWindow) {
      const compactableMessages = [{ role: 'system', content: effectiveSystem }, ...apiMessages];
      const showCompactionStart = shouldShowCompactionStart(compactableMessages, contextWindow);
      if (showCompactionStart) {
        webContents.send('chat:compaction', { streamId, stage: 'start' });
      }
      const compactResult = await compactIfNeeded({
        messages: compactableMessages,
        systemPrompt: effectiveSystem,
        contextWindow,
        providerConfig,
        signal,
      });
      if (compactResult.compacted) {
        // Re-separate system from conversation messages for Anthropic
        effectiveSystem = compactResult.messages
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n\n');
        apiMessages = compactResult.messages.filter((m) => m.role !== 'system');
        await persistAndNotifyCompaction({
          persistCompaction,
          conversationId,
          compactResult,
          streamId,
          webContents,
        });
      } else if (showCompactionStart) {
        webContents.send('chat:compaction', { streamId, stage: 'idle' });
      }
    }
    apiMessages = sanitizeApiMessages(apiMessages);
    const body = { model, system: effectiveSystem, messages: apiMessages, max_tokens: 16384, stream: true, tools: TOOLS_ANTHROPIC };
    if (effort === 'high') {
      body.thinking = { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET.high };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (isPromptTooLongResponse(res.status, text)) {
        webContents.send('chat:compaction', { streamId, stage: 'start', emergency: true });
        const compactResult = await compactIfNeeded({
          messages: [{ role: 'system', content: effectiveSystem }, ...apiMessages],
          systemPrompt: effectiveSystem,
          contextWindow,
          providerConfig: null,
          signal,
          force: true,
        });
        if (compactResult.compacted) {
          effectiveSystem = compactResult.messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n\n');
          apiMessages = compactResult.messages.filter((m) => m.role !== 'system');
          await persistAndNotifyCompaction({
            persistCompaction,
            conversationId,
            compactResult,
            streamId,
            webContents,
            emergency: true,
          });
          continue;
        }
        webContents.send('chat:compaction', { streamId, stage: 'idle', emergency: true });
      }
      webContents.send('chat:stream:error', { streamId, error: `HTTP ${res.status}: ${text.slice(0, 300)}` });
      return;
    }

    const { textContent, toolUseBlocks, stopReason, streamUsage } = await consumeAnthropicStream(res, webContents, streamId);
    if (streamUsage) {
      usage.inputTokens += streamUsage.inputTokens || 0;
      usage.outputTokens += streamUsage.outputTokens || 0;
      usage.cacheWriteTokens += streamUsage.cacheWriteTokens || 0;
      usage.cacheReadTokens += streamUsage.cacheReadTokens || 0;
    }

    if (stopReason !== 'tool_use' || !toolUseBlocks.length) {
      webContents.send('chat:stream:done', { streamId, usage });
      return;
    }

    const assistantContent = [];
    if (textContent) assistantContent.push({ type: 'text', text: textContent });
    for (const tu of toolUseBlocks) {
      assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: safeParseJson(tu.inputJson) });
    }
    apiMessages.push({ role: 'assistant', content: assistantContent });

    const toolResults = [];
    for (const tu of toolUseBlocks) {
      const args = safeParseJson(tu.inputJson);
      webContents.send('chat:stream:tool-call', { streamId, tool: tu.name, args, toolCallId: tu.id });
      const result = await executeTool(tu.name, args, activeWorkspacePath);
      const output = result.success ? result.output : `Error: ${result.error}${result.stderr ? '\n' + result.stderr : ''}`;
      webContents.send('chat:stream:tool-result', { streamId, toolCallId: tu.id, result: output.slice(0, 4000) });
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: output });
    }
    apiMessages.push({ role: 'user', content: toolResults });
  }

  webContents.send('chat:stream:done', { streamId, usage });
}

async function consumeAnthropicStream(res, webContents, streamId) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let textContent = '';
  const toolUseBlocks = [];
  let currentToolIndex = -1;
  let stopReason = null;
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      try {
        const parsed = JSON.parse(trimmed.slice(6));
        if (parsed.type === 'content_block_start') {
          if (parsed.content_block?.type === 'tool_use') {
            currentToolIndex = toolUseBlocks.length;
            toolUseBlocks.push({ id: parsed.content_block.id, name: parsed.content_block.name, inputJson: '' });
          } else {
            currentToolIndex = -1;
          }
        } else if (parsed.type === 'content_block_delta') {
          if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
            textContent += parsed.delta.text;
            webContents.send('chat:stream:delta', { streamId, content: parsed.delta.text });
          } else if (parsed.delta?.type === 'input_json_delta' && currentToolIndex >= 0) {
            toolUseBlocks[currentToolIndex].inputJson += parsed.delta.partial_json;
          }
        } else if (parsed.type === 'message_delta') {
          if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
          if (parsed.usage) {
            usage = { ...(usage || {}), outputTokens: parsed.usage.output_tokens ?? 0 };
            webContents.send('chat:stream:usage', { streamId, usage });
          }
        } else if (parsed.type === 'message_start' && parsed.message?.usage) {
          const u = parsed.message.usage;
          usage = {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
          };
          webContents.send('chat:stream:usage', { streamId, usage });
        }
      } catch { /* skip */ }
    }
  }

  return { textContent, toolUseBlocks, stopReason, streamUsage: usage };
}

function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return {}; }
}
