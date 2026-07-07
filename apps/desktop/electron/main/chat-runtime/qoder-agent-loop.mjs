import { sendQoderPrivateStream } from '../provider-adapters/qoder-private-adapter.mjs';
import {
  createAgentLoopKernel,
  handleTerminalTextResponse,
} from './agent-loop-kernel.mjs';
import { computeContextInfo } from './compaction-coordinator.mjs';
import { sanitizeApiMessages } from './message-sanitizer.mjs';
import * as responseGuard from './response-guard.mjs';
import { executeModelToolCall } from './tool-orchestrator.mjs';

function makeAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function normalizeLiteralToolArguments(raw) {
  const args = raw?.input ?? raw?.args ?? raw?.arguments ?? raw?.parameters ?? raw?.function?.arguments ?? {};
  if (typeof args === 'string') return args;
  if (args && typeof args === 'object') return JSON.stringify(args);
  return '{}';
}

function contentToFallbackText(content) {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        if (part?.type === 'tool_result') {
          return `Tool result:\n${contentToFallbackText(part.content)}`;
        }
        if (part?.type === 'tool_use') {
          return '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

function functionToolName(tool) {
  const fn = tool?.function && typeof tool.function === 'object' ? tool.function : tool;
  return typeof fn?.name === 'string' ? fn.name.trim() : '';
}

function qoderFallbackToolList(tools) {
  const names = Array.isArray(tools) ? tools.map(functionToolName).filter(Boolean) : [];
  if (!names.length) return 'Available tools: none.';
  return `Available tool names: ${names.join(', ')}.`;
}

function flattenMessagesForQoderLiteralTools(messages) {
  if (!Array.isArray(messages)) return [];
  const toolNamesById = new Map();
  const flattened = [];
  for (const message of messages) {
    const role = String(message?.role || '').trim();
    const text = contentToFallbackText(message?.content);
    if (role === 'assistant') {
      if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
          const id = typeof tc?.id === 'string' ? tc.id : '';
          const name = tc?.function?.name || tc?.name || '';
          if (id && name) toolNamesById.set(id, name);
        }
      }
      if (text.trim()) flattened.push({ role: 'assistant', content: text });
      continue;
    }
    if (role === 'tool') {
      const name = toolNamesById.get(message?.tool_call_id) || 'tool';
      flattened.push({
        role: 'user',
        content: `Result from ${name}:\n${text}`,
      });
      continue;
    }
    flattened.push({
      role: ['system', 'user'].includes(role) ? role : 'user',
      content: text,
    });
  }
  return flattened.filter((message) => String(message.content || '').trim());
}

function qoderLiteralToolInstruction(tools = []) {
  return [
    'Tool calling for this Qoder channel uses the Qoder literal tool-call dialect.',
    'Do not use native function calls.',
    'When a tool is needed, emit exactly one or more pure tool-call blocks and no other text.',
    'Each block must use an opening tag named tool_call, a compact JSON object with name and input fields, and the matching closing tag.',
    qoderFallbackToolList(tools),
    'Use only those tool names. If no tool is needed, answer normally.',
  ].join(' ');
}

function withQoderLiteralToolInstruction(messages, tools) {
  if (!Array.isArray(tools) || !tools.length) return messages;
  const instruction = { role: 'user', content: qoderLiteralToolInstruction(tools) };
  const firstNonSystemIndex = messages.findIndex((message) => message?.role !== 'system');
  if (firstNonSystemIndex < 0) return [...messages, instruction];
  return [
    ...messages.slice(0, firstNonSystemIndex),
    instruction,
    ...messages.slice(firstNonSystemIndex),
  ];
}

export function parseQoderLiteralToolCalls(text) {
  const value = String(text || '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .trim();
  if (!value || !value.includes('<tool_call')) return [];
  const calls = [];
  let remainder = value;
  const pattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    remainder = remainder.replace(match[0], '');
    try {
      const parsed = JSON.parse(match[1]);
      const name = String(parsed?.name || parsed?.tool || parsed?.function?.name || '').trim();
      if (!name) return [];
      calls.push({
        id: String(parsed?.id || `qoder_literal_tool_${calls.length + 1}`),
        name,
        arguments: normalizeLiteralToolArguments(parsed),
      });
    } catch {
      return [];
    }
  }
  return calls.length > 0 && !remainder.trim() ? calls : [];
}

export async function agentLoopQoder({
  baseUrl,
  apiKey,
  model = 'Auto',
  systemPrompt,
  messages,
  tools = [],
  webContents,
  streamId,
  signal,
  contextWindow,
  conversationId,
  toolContext,
  workspacePath,
  permissionGate,
  registry,
  runtimeProjection,
  mcpRegistry,
  goalPlanStore,
  agentProgress = null,
  maxOutputTokens = 0,
  resolvedChannel = null,
  sendStream = sendQoderPrivateStream,
}) {
  const apiMessages = sanitizeApiMessages([{ role: 'system', content: systemPrompt }, ...messages]);
  const loop = createAgentLoopKernel({
    webContents,
    streamId,
    onRound: agentProgress?.onRound,
    getContextInfo: () => computeContextInfo({
      messages: apiMessages,
      contextWindow,
      tools,
    }),
  });
  const literalToolMode = tools.length > 0;

  for (let turn = 0; turn < loop.maxTurns; turn++) {
    const requestTools = literalToolMode ? [] : tools;
    const requestMessages = literalToolMode
      ? withQoderLiteralToolInstruction(flattenMessagesForQoderLiteralTools(sanitizeApiMessages(apiMessages)), tools)
      : sanitizeApiMessages(apiMessages);
    const providerResponse = await sendStream({
      baseUrl,
      apiKey,
      endpoint: resolvedChannel?.endpoint,
      model,
      messages: requestMessages,
      tools: requestTools,
      maxOutputTokens,
      signal,
      webContents,
      streamId,
    });

    if (signal?.aborted) throw makeAbortError();
    loop.addUsage(providerResponse.streamUsage);
    if (!providerResponse.ok) {
      if (providerResponse.providerError) {
        loop.sendError(`${providerResponse.errorText || 'qoder_private_error'}${providerResponse.providerTracePath ? ` provider_trace=${providerResponse.providerTracePath}` : ''}`);
        return;
      }
      loop.sendHttpError(providerResponse.status, providerResponse.errorText || 'qoder_private_error');
      return;
    }

    const content = providerResponse.content || '';
    const thinkingContent = providerResponse.thinkingContent || '';
    const toolCalls = Array.isArray(providerResponse.toolCalls) && providerResponse.toolCalls.length
      ? providerResponse.toolCalls
      : parseQoderLiteralToolCalls(content);

    if (!toolCalls.length) {
      const terminalResponse = handleTerminalTextResponse({
        text: content,
        thinking: thinkingContent,
        providerTracePath: providerResponse.providerTracePath,
        apiMessages,
        loop,
        responseGuard,
      });
      if (terminalResponse.action === 'retry') continue;
      return;
    }

    apiMessages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    let terminalControlSignal = null;
    for (const tc of toolCalls) {
      const toolExecution = await executeModelToolCall({
        name: tc.name,
        rawArguments: tc.arguments,
        toolCallId: tc.id,
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
      });
      if (toolExecution.aborted) return;
      apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolExecution.output });
      if (toolExecution.controlSignal?.terminal) terminalControlSignal = toolExecution.controlSignal;
    }

    if (terminalControlSignal) {
      loop.sendDone();
      return;
    }
  }

  loop.sendLoopExhausted();
}
