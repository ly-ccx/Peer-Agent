import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { agentLoopQoder, parseQoderLiteralToolCalls } from './qoder-agent-loop.mjs';
import { createToolContext } from './tool-orchestrator.mjs';

describe('agentLoopQoder', () => {
  it('parses GLM literal tool_call blocks only when the content is purely tool calls', () => {
    assert.deepEqual(
      parseQoderLiteralToolCalls('<tool_call>{"name":"bash","input":{"command":"pwd"}}</tool_call>'),
      [{ id: 'qoder_literal_tool_1', name: 'bash', arguments: '{"command":"pwd"}' }],
    );
    assert.deepEqual(
      parseQoderLiteralToolCalls('example: <tool_call>{"name":"bash","input":{}}</tool_call>'),
      [],
    );
  });

  it('sends tools, executes returned tool calls, and continues with tool results', async () => {
    const sent = [];
    const attempts = [];
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
      tools: [{ type: 'function', function: { name: 'missing_tool', parameters: { type: 'object' } } }],
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-tool',
      contextWindow: 1000,
      toolContext: createToolContext({ conversationId: 'conv-qoder-loop', mode: 'chat' }),
      permissionGate: {
        createFilePermissionRequester: () => async () => ({ granted: true }),
        createLocalCapabilityPermissionRequester: () => async () => ({ granted: true }),
        createShellApprovalDecider: () => async () => ({ approved: true }),
      },
      sendStream,
    });

    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].tools[0].function.name, 'missing_tool');
    assert.equal(attempts[1].messages.at(-1).role, 'tool');
    assert.match(attempts[1].messages.at(-1).content, /Unknown tool: missing_tool/);
    assert.ok(sent.some((event) => event.channel === 'chat:stream:tool-call'));
    assert.ok(sent.some((event) => event.channel === 'chat:stream:tool-result'));
    assert.ok(sent.some((event) => event.channel === 'chat:stream:done'));
  });

  it('executes pure GLM literal tool_call text as a Qoder tool-call dialect', async () => {
    const sent = [];
    const attempts = [];
    const sendStream = async (args) => {
      attempts.push(args);
      if (attempts.length === 1) {
        return {
          ok: true,
          content: '<tool_call>{"name":"missing_tool","input":{"value":1}}</tool_call>',
          thinkingContent: '',
          toolCalls: [],
          streamUsage: null,
        };
      }
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
      model: 'gm51model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'run a tool' }],
      tools: [{ type: 'function', function: { name: 'missing_tool', parameters: { type: 'object' } } }],
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-literal-tool',
      permissionGate: {
        createFilePermissionRequester: () => async () => ({ granted: true }),
        createLocalCapabilityPermissionRequester: () => async () => ({ granted: true }),
        createShellApprovalDecider: () => async () => ({ approved: true }),
      },
      sendStream,
    });

    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].messages.at(-1).role, 'tool');
    assert.match(attempts[1].messages.at(-1).content, /Unknown tool: missing_tool/);
    assert.ok(sent.some((event) => event.channel === 'chat:stream:tool-call'));
    assert.ok(sent.some((event) => event.channel === 'chat:stream:done'));
  });

  it('retries instead of displaying literal GLM tool_call text', async () => {
    const attempts = [];
    const sent = [];
    const sendStream = async (args) => {
      attempts.push(args);
      if (attempts.length === 1) {
        return {
          ok: true,
          content: 'I should call <tool_call>{"name":"bash","input":{"command":"pwd"}}</tool_call>',
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
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-leaked-tool',
      sendStream,
    });

    assert.equal(attempts.length, 2);
    assert.match(attempts[1].messages.at(-1).content, /emitted no actual tool call/);
    assert.ok(sent.some((event) => event.channel === 'chat:stream:done'));
  });
});
