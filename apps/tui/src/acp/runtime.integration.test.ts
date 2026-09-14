import { expect, test } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

for (const decision of ['text', 'allow-once', 'deny', 'cancel', 'disconnect', 'running-cancel', 'running-disconnect']) {
  test(`real stdio runtime with isolated HOME / ${decision}`, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'peer-acp-e2e-'));
    const running = decision.startsWith('running-');
    const tool = running ? { name: 'bash', arguments: JSON.stringify({ command: `echo ${String.fromCharCode(36, 36)} > '${home}/started.pid'; sleep 10; echo unexpected > '${home}/late.txt'`, runInBackground: false }) }
      : { name: 'write_file', arguments: JSON.stringify({ path: path.join(home, 'approved.txt'), content: 'approved evidence', allow_overwrite: false }) };
    let modelRequests = 0;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (request) => {
      await request.json();
      modelRequests++;
      const chunks = decision !== 'text' && modelRequests === 1 ? [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'acp-write', type: 'function', function: tool }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ] : [
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'ACP runtime verified' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ];
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    const command = process.env.PEER_ACP_TEST_BINARY ? [process.env.PEER_ACP_TEST_BINARY, 'acp'] : [process.execPath, new URL('../index.tsx', import.meta.url).pathname, 'acp'];
    const child = Bun.spawn(command, {
      env: { ...process.env, HOME: home, NO_PROXY: '*', no_proxy: '*', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', PEER_MODEL_API_KEY: 'local-test-only', PEER_MODEL_BASE_URL: `http://127.0.0.1:${server.port}/v1`, PEER_MODEL_ID: 'test-model' },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const stderr = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const updates: any[] = [];
    const timer = setTimeout(() => child.kill(), 20000);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    async function rpc(id: number, method: string, params: unknown): Promise<any> {
      send({ jsonrpc: '2.0', id, method, params });
      while (true) {
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n');
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          const message = JSON.parse(line);
          expect(message.jsonrpc).toBe('2.0');
          if (message.id === id) {
            if (message.error) {
              child.stdin.end(); await child.exited;
              throw new Error(JSON.stringify({ error: message.error, modelRequests, updates, stderr: await stderr }));
            }
            return message.result;
          }
          updates.push(message);
          if (message.method === 'session/request_permission') {
            expect(message.params.toolCall.toolCallId).toBe('acp-write');
            if (running) {
              send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
              let pid = 0;
              for (let attempt = 0; attempt < 200; attempt++) {
                pid = Number(await readFile(path.join(home, 'started.pid'), 'utf8').catch(() => '0'));
                if (pid > 0) break;
                await Bun.sleep(10);
              }
              expect(pid).toBeGreaterThan(0);
              process.kill(pid, 0);
              if (decision === 'running-disconnect') child.stdin.end();
              else send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: message.params.sessionId } });
              for (let attempt = 0; attempt < 200; attempt++) {
                try { process.kill(pid, 0); } catch { pid = 0; break; }
                await Bun.sleep(10);
              }
              expect(pid).toBe(0);
              expect(await readFile(path.join(home, 'late.txt'), 'utf8').catch(() => null)).toBeNull();
              if (decision === 'running-disconnect') {
                expect(await child.exited).toBe(0);
                return { disconnected: true };
              }
            } else if (decision === 'disconnect') {
              child.stdin.end(); expect(await child.exited).toBe(0);
              return { disconnected: true };
            } else if (decision === 'cancel') {
              send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: message.params.sessionId } });
            } else {
              send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: decision } } });
            }
          }
        }
        const next = await reader.read();
        if (next.done) throw new Error(`ACP exited: ${await stderr}`);
        buffer += decoder.decode(next.value, { stream: true });
      }
    }
    try {
      await rpc(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
      const { sessionId } = await rpc(2, 'session/new', { cwd: home, mcpServers: [] });
      const result = await rpc(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Reply briefly.' }] });
      if (decision.endsWith('disconnect')) {
        expect(result.disconnected).toBe(true);
        expect(await readFile(path.join(home, 'approved.txt'), 'utf8').catch(() => null)).toBeNull();
        return;
      }
      expect(result.stopReason).toBe(decision.endsWith('cancel') ? 'cancelled' : 'end_turn');
      if (decision !== 'text') {
        expect(updates.some((event) => event.method === 'session/request_permission')).toBe(true);
        expect(await readFile(path.join(home, 'approved.txt'), 'utf8').catch(() => null)).toBe(decision === 'allow-once' ? 'approved evidence' : null);
        const evidence = await readFile(path.join(home, '.peer-agent', 'goal-plans', 'evidence-index.jsonl'), 'utf8');
        expect(evidence).toContain('tool-result://acp-write');
        expect(evidence).toContain(running ? 'local.shell' : 'local.file.write');
      }
      expect(modelRequests).toBeGreaterThan(0);
      if (!decision.endsWith('cancel')) expect(updates.filter((event) => event.method === 'session/update').map((event) => event.params.update.content?.text ?? '').join('')).toContain('ACP runtime verified');
      child.stdin.end(); expect(await child.exited).toBe(0);
    } finally {
      clearTimeout(timer); child.kill(); await child.exited;
      reader.releaseLock(); server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  }, 25000);
}
