import { expect, test } from 'bun:test';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { createPeerAcpAgent } from './agent.ts';

test('production agent rejects requests before initialization and unsupported versions', async () => {
  const peer = createPeerAcpAgent(async () => ({ async prompt() {}, async dispose() {} }), async () => {});
  const { agent } = peer;
  await expect(agent.newSession({ cwd: process.cwd(), mcpServers: [] })).rejects.toThrow('Initialize first');
  await expect(agent.initialize({ protocolVersion: -1 })).rejects.toThrow('Unsupported protocol version');
  const result = await agent.initialize({ protocolVersion: PROTOCOL_VERSION });
  expect(result.agentCapabilities?.loadSession).toBe(false);
  const session = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  expect(session.sessionId).toBeString();
  await peer.close();
});

for (const scenario of [
  { name: 'unknown method', method: 'unknown', params: {}, code: -32601 },
  { name: 'invalid parameters', method: 'initialize', params: {}, code: -32602 },
  { name: 'session before initialize', method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] }, code: -32600 },
]) {
  test(`real CLI protocol error / ${scenario.name}`, async () => {
    const child = Bun.spawn([process.execPath, new URL('../index.tsx', import.meta.url).pathname, 'acp'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), 5000);
    const reader = child.stdout.getReader();
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 42, method: scenario.method, params: scenario.params }) + '\n');
      const { value } = await reader.read();
      const response = JSON.parse(new TextDecoder().decode(value).trim());
      expect(response.id).toBe(42);
      expect(response.error.code).toBe(scenario.code);
      child.stdin.end();
      expect(await child.exited).toBe(0);
    } finally {
      clearTimeout(timer);
      child.kill();
      reader.releaseLock();
    }
  });
}

for (const input of [
  { name: 'malformed JSON', line: '{broken', code: -32700 },
  { name: 'scalar JSON', line: '42', code: -32600 },
]) {
  test(`real CLI rejects ${input.name} and recovers`, async () => {
    const child = Bun.spawn([process.execPath, new URL('../index.tsx', import.meta.url).pathname, 'acp'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    const timer = setTimeout(() => child.kill(), 5000);
    let buffer = '';
    async function nextMessage() {
      while (!buffer.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Unexpected protocol EOF');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const end = buffer.indexOf('\n');
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      return message;
    }
    try {
      child.stdin.write(input.line + '\n');
      expect(await nextMessage()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: input.code } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } }) + '\n');
      expect(await nextMessage()).toMatchObject({ id: 9, result: { protocolVersion: PROTOCOL_VERSION } });
      child.stdin.end();
      expect(await child.exited).toBe(0);
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited;
      reader.releaseLock();
    }
  });
}

test('real CLI subprocess accepts initialization without TTY and writes only JSON', async () => {
  const child = Bun.spawn([process.execPath, new URL('../index.tsx', import.meta.url).pathname, 'acp'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} } }) + '\n');
  const reader = child.stdout.getReader();
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const { value } = await reader.read();
    const message = JSON.parse(new TextDecoder().decode(value).trim());
    expect(message.id).toBe(1);
    expect(message.result.protocolVersion).toBe(PROTOCOL_VERSION);
    child.stdin.end();
    expect(await child.exited).toBe(0);
  } finally {
    clearTimeout(timer);
    child.kill();
    reader.releaseLock();
  }
});
