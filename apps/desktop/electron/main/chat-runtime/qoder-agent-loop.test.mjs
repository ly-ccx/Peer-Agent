import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { agentLoopQoder } from './qoder-agent-loop.mjs';
import { createToolContext } from './tool-orchestrator.mjs';

describe('agentLoopQoder', () => {
  it('sends structured tools to Qoder and continues with native tool result messages', async () => {
    const sent = [];
    const attempts = [];
    const tools = [{ type: 'function', function: { name: 'missing_tool', parameters: { type: 'object' } } }];
    const sendStream = async (args) => {
      attempts.push(args);
      if (attempts.length === 1) {
        return {
          ok: true,
          content: '',
          thinkingContent: '',
          toolCalls: [{ id: 'call_1', name: 'missing_tool', arguments: '{"value":1}' }],
          streamUsage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      return {
        ok: true,
        content: 'done',
        thinkingContent: '',
        toolCalls: [],
        streamUsage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    };

    await agentLoopQoder({
      baseUrl: 'https://example.test/model/v1',
      apiKey: 'token',
      model: 'gm51model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'run a tool' }],
      tools,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-native-tool',
      contextWindow: 1000,
      modelOptions: [{ key: 'context_window', choices: [{ value: '1M', metadata: { contextWindow: 1_000_000 } }] }],
      modelOptionValues: { context_window: '1M' },
      toolContext: createToolContext({ conversationId: 'conv-qoder-loop', mode: 'chat' }),
      permissionGate: {
        createFilePermissionRequester: () => async () => ({ granted: true }),
        createLocalCapabilityPermissionRequester: () => async () => ({ granted: true }),
        createShellApprovalDecider: () => async () => ({ approved: true }),
      },
      sendStream,
    });

    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].modelOptions, [{
      key: 'context_window',
      choices: [{ value: '1M', metadata: { contextWindow: 1_000_000 } }],
    }]);
    assert.deepEqual(attempts[0].modelOptionValues, { context_window: '1M' });
    assert.deepEqual(attempts[0].tools, tools);
    assert.equal(attempts[0].messages.some((message) => /tool-call dialect/i.test(message.content)), false);
    assert.equal(attempts[1].messages.some((message) => Array.isArray(message.tool_calls)), true);
    assert.equal(attempts[1].messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_1'), true);
    assert.match(attempts[1].messages.at(-1).content, /Unknown tool: missing_tool/);
    assert.ok(sent.some((event) => event.channel === 'chat:stream:tool-call'));
    assert.ok(sent.some((event) => event.channel === 'chat:stream:tool-result'));
    assert.ok(sent.some((event) => event.channel === 'chat:stream:done'));
  });

  it('preserves historical native tool protocol instead of flattening to prose', async () => {
    const attempts = [];
    const tools = [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }];
    const sendStream = async (args) => {
      attempts.push(args);
      return {
        ok: true,
        content: 'done',
        thinkingContent: '',
        toolCalls: [],
        streamUsage: null,
      };
    };

    await agentLoopQoder({
      baseUrl: 'https://example.test/model/v1',
      apiKey: 'token',
      model: 'ultimate',
      systemPrompt: 'system',
      messages: [
        { role: 'user', content: 'inspect repo' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tool_call_0',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"pwd"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'tool_call_0', content: '/tmp/project' },
        { role: 'user', content: 'continue' },
      ],
      tools,
      webContents: { send: () => {} },
      streamId: 'qoder-loop-native-history',
      sendStream,
    });

    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0].tools, tools);
    assert.equal(attempts[0].messages.some((message) => Array.isArray(message.tool_calls)), true);
    assert.equal(attempts[0].messages.some((message) => message.role === 'tool' && message.tool_call_id === 'tool_call_0'), true);
    assert.equal(attempts[0].messages.some((message) => /Result from bash/.test(message.content)), false);
    assert.equal(attempts[0].messages.some((message) => /tool-call dialect/i.test(message.content)), false);
  });

  it('retries literal tool-call protocol text instead of executing it as a Qoder dialect', async () => {
    const attempts = [];
    const sent = [];
    const tools = [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }];
    const sendStream = async (args) => {
      attempts.push(args);
      if (attempts.length === 1) {
        return {
          ok: true,
          content: '<tool_call>{"name":"bash","input":{"command":"pwd"}}</tool_call>',
          thinkingContent: '',
          toolCalls: [],
          streamUsage: null,
        };
      }
      return {
        ok: true,
        content: 'clean answer',
        thinkingContent: '',
        toolCalls: [],
        streamUsage: null,
      };
    };

    await agentLoopQoder({
      baseUrl: 'https://example.test/model/v1',
      apiKey: 'token',
      model: 'gm51model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'search repo' }],
      tools,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-leaked-tool',
      sendStream,
    });

    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].tools, tools);
    assert.deepEqual(attempts[1].tools, tools);
    assert.ok(attempts[1].messages.some((message) => /emitted tool-call protocol text/.test(message.content)));
    assert.equal(attempts[1].messages.some((message) => /tool-call dialect/i.test(message.content)), false);
    assert.equal(sent.some((event) => event.channel === 'chat:stream:tool-call'), false);
    assert.ok(sent.some((event) => event.channel === 'chat:stream:done'));
  });

  it('reports Qoder thinking-only output instead of silently finishing', async () => {
    const sent = [];
    const attempts = [];
    const tools = [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }];
    const sendStream = async (args) => {
      attempts.push(args);
      return {
        ok: true,
        content: '',
        thinkingContent: 'I need to examine the files before answering.',
        toolCalls: [],
        streamUsage: null,
        providerTracePath: '/tmp/qoder-thinking-only.jsonl',
      };
    };

    await agentLoopQoder({
      baseUrl: 'https://example.test/model/v1',
      apiKey: 'token',
      model: 'gm51model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'check why it stopped' }],
      tools,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-thinking-only',
      sendStream,
    });

    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].tools, tools);
    assert.equal(attempts[0].bufferThinkingDeltas, false);
    assert.equal(attempts[0].emitBufferedThinkingDeltas, true);
    assert.equal(attempts[0].streamIdleTimeoutMs, 30000);
    assert.ok(attempts[1].messages.some((message) => /reasoning-only output/.test(message.content)));
    assert.equal(sent.some((event) => event.channel === 'chat:stream:done'), false);
    const error = sent.find((event) => event.channel === 'chat:stream:error');
    assert.match(error?.payload?.error, /qoder_thinking_only_response/);
    assert.match(error?.payload?.error, /provider_trace=\/tmp\/qoder-thinking-only\.jsonl/);
  });

  it('allows normal Qoder prose without hard-failing the turn', async () => {
    const sent = [];
    const attempts = [];
    const sendStream = async (args) => {
      attempts.push(args);
      return {
        ok: true,
        content: 'I ran git status and checked the files.',
        thinkingContent: '',
        toolCalls: [],
        streamUsage: null,
        providerTracePath: '/tmp/qoder-execution-claim-prose.jsonl',
      };
    };

    await agentLoopQoder({
      baseUrl: 'https://example.test/model/v1',
      apiKey: 'token',
      model: 'ultimate',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'continue' }],
      tools: [],
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-normal-prose',
      sendStream,
    });

    assert.equal(attempts.length, 1);
    assert.equal(sent.some((event) => event.channel === 'chat:stream:error'), false);
    assert.equal(sent.some((event) => event.channel === 'chat:stream:done'), true);
  });

  it('reports Qoder thinking-only planning text after native tool turns', async () => {
    const sent = [];
    const attempts = [];
    const tools = [{ type: 'function', function: { name: 'missing_tool', parameters: { type: 'object' } } }];
    const planningThinking = [
      "I'll extend the existing Dropdown component to support optional grouping",
      'by adding a groups parameter alongside the flat options.',
    ].join(' ');
    const sendStream = async (args) => {
      attempts.push(args);
      if (attempts.length === 1) {
        return {
          ok: true,
          content: '',
          thinkingContent: '',
          toolCalls: [{ id: 'call_1', name: 'missing_tool', arguments: '{"value":1}' }],
          streamUsage: null,
        };
      }
      return {
        ok: true,
        content: '',
        thinkingContent: planningThinking,
        toolCalls: [],
        streamUsage: null,
        providerTracePath: '/tmp/qoder-thinking-only-after-tools.jsonl',
      };
    };

    await agentLoopQoder({
      baseUrl: 'https://example.test/model/v1',
      apiKey: 'token',
      model: 'ultimate',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'continue' }],
      tools,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-thinking-only-after-tools',
      permissionGate: {
        createFilePermissionRequester: () => async () => ({ granted: true }),
        createLocalCapabilityPermissionRequester: () => async () => ({ granted: true }),
        createShellApprovalDecider: () => async () => ({ approved: true }),
      },
      sendStream,
    });

    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts[0].tools, tools);
    assert.deepEqual(attempts[1].tools, tools);
    assert.equal(attempts[1].messages.some((message) => Array.isArray(message.tool_calls)), true);
    assert.equal(attempts[1].messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_1'), true);
    assert.equal(attempts.at(-1).messages.at(-1).role, 'user');
    assert.match(attempts.at(-1).messages.at(-1).content, /reasoning-only output/);
    assert.equal(sent.some((event) => event.channel === 'chat:stream:done'), false);
    const error = sent.find((event) => event.channel === 'chat:stream:error');
    assert.match(error?.payload?.error, /qoder_thinking_only_response/);
    assert.match(error?.payload?.error, /provider_trace=\/tmp\/qoder-thinking-only-after-tools\.jsonl/);
  });

  it('surfaces HTTP errors while still sending native tools to Qoder', async () => {
    const sent = [];
    const attempts = [];
    const tools = [{ type: 'function', function: { name: 'missing_tool', parameters: { type: 'object' } } }];
    const sendStream = async (args) => {
      attempts.push(args);
      return {
        ok: false,
        status: 500,
        errorText: '{"error":"internal server error"}',
        providerTracePath: '/tmp/qoder-500-trace.jsonl',
      };
    };

    await agentLoopQoder({
      baseUrl: 'https://example.test/model/v1',
      apiKey: 'token',
      model: 'ultimate',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'run a tool' }],
      tools,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-http-500',
      sendStream,
    });

    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0].tools, tools);
    assert.equal(attempts[0].messages.some((message) => /tool-call dialect/i.test(message.content)), false);
    const error = sent.find((event) => event.channel === 'chat:stream:error');
    assert.match(error?.payload?.error, /HTTP 500/);
    assert.equal(sent.some((event) => event.channel === 'chat:stream:done'), false);
  });
});
