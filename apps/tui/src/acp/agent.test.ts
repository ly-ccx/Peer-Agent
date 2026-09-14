import { expect, test } from 'bun:test';
import { PROTOCOL_VERSION, type SessionNotification } from '@agentclientprotocol/sdk';
import { createPeerAcpAgent } from './agent.ts';

for (const ending of ['normal', 'cancel', 'failure', 'disconnect'] as const) {
  test(`isolated streaming sessions / ${ending}`, async () => {
    const events: SessionNotification[] = [];
    const release: (() => void)[] = [];
    let disposed = 0;
    const peer = createPeerAcpAgent(async (_cwd, update) => ({
      async prompt(text, signal) {
        await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
        await new Promise<void>((resolve) => {
          release.push(resolve);
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        if (ending === 'failure') throw new Error('sensitive runtime detail');
      },
      async dispose() { disposed++; },
    }), async (event) => { events.push(event); });
    await peer.agent.initialize({ protocolVersion: PROTOCOL_VERSION });
    const first = await peer.agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const second = await peer.agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    expect(first.sessionId).not.toBe(second.sessionId);
    const a = peer.agent.prompt({ sessionId: first.sessionId, prompt: [{ type: 'text', text: 'first' }] });
    const b = peer.agent.prompt({ sessionId: second.sessionId, prompt: [{ type: 'text', text: 'second' }] });
    // Attach rejection handlers before the failing runtime is released.
    const results = Promise.allSettled([a, b]);
    await Promise.resolve(); await Promise.resolve();
    await expect(peer.agent.prompt({ sessionId: first.sessionId, prompt: [{ type: 'text', text: 'overlap' }] })).rejects.toThrow('active prompt');
    expect(events.map((event) => event.sessionId)).toEqual([first.sessionId, second.sessionId]);
    if (ending === 'cancel') await peer.agent.cancel({ sessionId: first.sessionId });
    if (ending === 'disconnect') await peer.close();
    else release.forEach((resolve) => resolve());
    const settled = await results;
    if (ending === 'failure') {
      expect(settled.every((item) => item.status === 'rejected')).toBe(true);
      expect(String((settled[0] as PromiseRejectedResult).reason)).not.toContain('sensitive');
    } else {
      expect(await a).toEqual({ stopReason: ending === 'cancel' || ending === 'disconnect' ? 'cancelled' : 'end_turn' });
      expect(await b).toEqual({ stopReason: ending === 'disconnect' ? 'cancelled' : 'end_turn' });
    }
    await peer.close();
    expect(disposed).toBe(2);
  });
}

test('invalid lifecycle, workspace, capabilities and prompts never reach runtime', async () => {
  let calls = 0;
  const peer = createPeerAcpAgent(async () => { calls++; return { async prompt() {}, async dispose() {} }; }, async () => {});
  await expect(peer.agent.newSession({ cwd: process.cwd(), mcpServers: [] })).rejects.toThrow('Initialize first');
  await peer.agent.initialize({ protocolVersion: PROTOCOL_VERSION });
  await expect(peer.agent.newSession({ cwd: '.', mcpServers: [] })).rejects.toThrow('absolute directory');
  await expect(peer.agent.newSession({ cwd: process.cwd(), mcpServers: [{ name: 'unsupported', command: 'x', args: [], env: [] }] })).rejects.toThrow('not supported');
  expect(calls).toBe(0);
  const { sessionId } = await peer.agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  await expect(peer.agent.prompt({ sessionId, prompt: [{ type: 'image', data: '', mimeType: 'image/png' }] })).rejects.toThrow('Only text');
  await expect(peer.agent.prompt({ sessionId: 'unknown', prompt: [] })).rejects.toThrow('Unknown session');
  await peer.close();
});
