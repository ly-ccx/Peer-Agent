import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildClientRuntimeChatContext,
  normalizeMcpServersAsCapabilities,
} from './client-runtime-chat-context.mjs';

test('normalizeMcpServersAsCapabilities returns [] for non-array input', () => {
  assert.deepEqual(normalizeMcpServersAsCapabilities(undefined), []);
  assert.deepEqual(normalizeMcpServersAsCapabilities(null), []);
  assert.deepEqual(normalizeMcpServersAsCapabilities('foo'), []);
});

test('normalizeMcpServersAsCapabilities flattens tools into local.mcp.<id>.<tool>', () => {
  const out = normalizeMcpServersAsCapabilities([
    {
      mcpId: 1001,
      name: 'TimeServer',
      serverUrl: 'https://mcp.example.com/time',
      tools: [
        { toolName: 'now', toolDesc: 'current time' },
        { toolName: 'parse', toolDesc: 'parse iso string' },
      ],
    },
  ]);
  assert.deepEqual(out, [
    {
      capabilityId: 'local.mcp.1001.now',
      name: 'TimeServer / now',
      description: 'current time',
    },
    {
      capabilityId: 'local.mcp.1001.parse',
      name: 'TimeServer / parse',
      description: 'parse iso string',
    },
  ]);
});

test('normalizeMcpServersAsCapabilities skips servers without serverUrl or tools', () => {
  const out = normalizeMcpServersAsCapabilities([
    { mcpId: 'a', name: 'NoUrl', tools: [{ toolName: 'x' }] },
    { mcpId: 'b', name: 'NoTools', serverUrl: 'https://x', tools: [] },
    { mcpId: 'c', name: 'Empty', serverUrl: 'https://x' },
    {
      mcpId: 'd',
      name: 'Ok',
      serverUrl: 'https://x',
      tools: [{ toolName: 'ping' }],
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].capabilityId, 'local.mcp.d.ping');
});

test('normalizeMcpServersAsCapabilities skips disabled servers', () => {
  const out = normalizeMcpServersAsCapabilities([
    {
      mcpId: 'e',
      name: 'Disabled',
      enabled: false,
      serverUrl: 'https://x',
      tools: [{ toolName: 'ping' }],
    },
  ]);
  assert.deepEqual(out, []);
});

test('normalizeMcpServersAsCapabilities falls back to dingtalkActivation.serverUrl and tool.name', () => {
  const out = normalizeMcpServersAsCapabilities([
    {
      mcpId: 'f',
      name: 'Dingtalk MCP',
      dingtalkActivation: { serverUrl: 'https://dt/mcp' },
      tools: [{ name: 'whoami', description: 'who' }],
    },
  ]);
  assert.deepEqual(out, [
    {
      capabilityId: 'local.mcp.f.whoami',
      name: 'Dingtalk MCP / whoami',
      description: 'who',
    },
  ]);
});

test('normalizeMcpServersAsCapabilities omits description when blank', () => {
  const out = normalizeMcpServersAsCapabilities([
    {
      mcpId: 'g',
      name: 'Bare',
      serverUrl: 'https://x',
      tools: [{ toolName: 'ping' }],
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].capabilityId, 'local.mcp.g.ping');
  assert.equal(out[0].name, 'Bare / ping');
  assert.equal('description' in out[0], false);
});

test('buildClientRuntimeChatContext merges mcp capabilities into clientRuntime.capabilities', () => {
  const ctx = buildClientRuntimeChatContext({
    getSession: () => ({ sessionId: 'sess-1' }),
    buildRuntimeProjection: () => ({
      projectionId: 'sess-1',
      sessionId: 'sess-1',
      accessLevel: 'ask_before_local',
      capabilities: [{ capabilityId: 'local.shell.exec', name: 'Shell' }],
      skills: [{ skillId: 'demo', description: 'desc', enabled: true }],
      mcpServers: [
        {
          mcpId: 1001,
          name: 'TimeServer',
          serverUrl: 'https://mcp/time',
          tools: [{ toolName: 'now', toolDesc: 'current' }],
        },
      ],
    }),
  });

  const caps = ctx.sourceMetadata.clientRuntime.capabilities;
  const ids = caps.map((c) => c.capabilityId);
  assert.deepEqual(ids, [
    'local.shell.exec',
    'local.skill.demo',
    'local.mcp.1001.now',
  ]);
});

test('buildClientRuntimeChatContext deduplicates mcp capabilities already merged upstream', () => {
  const ctx = buildClientRuntimeChatContext({
    getSession: () => ({ sessionId: 'sess-2' }),
    buildRuntimeProjection: () => ({
      projectionId: 'sess-2',
      sessionId: 'sess-2',
      // 上游 main.mjs 的 buildRuntimeProjection 已经把 mcp 合入 capabilities
      capabilities: [
        { capabilityId: 'local.shell.exec', name: 'Shell' },
        { capabilityId: 'local.mcp.1001.now', name: 'TimeServer / now', description: 'current' },
      ],
      skills: [{ skillId: 'demo', description: 'desc', enabled: true }],
      mcpServers: [
        {
          mcpId: 1001,
          name: 'TimeServer',
          serverUrl: 'https://mcp/time',
          tools: [{ toolName: 'now', toolDesc: 'current' }],
        },
      ],
    }),
  });

  const ids = ctx.sourceMetadata.clientRuntime.capabilities.map((c) => c.capabilityId);
  // 顺序必须是：base 非 mcp → skill → mcp，并且 mcp 仅保留一份。
  assert.deepEqual(ids, ['local.shell.exec', 'local.skill.demo', 'local.mcp.1001.now']);
});

test('buildClientRuntimeChatContext returns {} when no signal at all', () => {
  const ctx = buildClientRuntimeChatContext({
    getSession: () => null,
    buildRuntimeProjection: () => ({}),
  });
  assert.deepEqual(ctx, {});
});
