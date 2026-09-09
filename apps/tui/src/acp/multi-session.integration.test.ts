import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSharedModelConfigPath } from '@peer-agent/runtime-node';
import { acpModelId } from './models.ts';

for (const decisions of [['allow-once', 'deny'], ['deny', 'allow-once']]) {
  test(`real concurrent sessions / ${decisions.join(' x ')}`, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'peer-acp-multi-'));
    const workspaces = [path.join(home, 'a'), path.join(home, 'b')];
    await Promise.all(workspaces.map((cwd) => mkdir(cwd)));
    const requestedModels: string[][] = [[], []];
    const requestedEfforts: unknown[][] = [[], []];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json() as any;
      const user = body.messages.findLast((message: any) => message.role === 'user');
      const index = JSON.stringify(user).includes('SESSION_B') ? 1 : 0;
      requestedModels[index]!.push(body.model);
      requestedEfforts[index]!.push(body.reasoning_effort);
      const done = body.messages.some((message: any) => message.role === 'tool');
      const delta = done ? { content: `DONE_${index}` } : {
        tool_calls: [{ index: 0, id: `write-${index}`, type: 'function', function: {
          name: 'write_file', arguments: JSON.stringify({ path: path.join(workspaces[index]!, 'result.txt'), content: `SESSION_${index}`, allow_overwrite: false }),
        } }],
      };
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    const dataHome = path.join(home, '.peer-agent');
    await mkdir(dataHome);
    const configPath = getSharedModelConfigPath(dataHome);
    const config = JSON.stringify(['model-a', 'model-b'].map((model) => ({
      id: 'test-provider', groupId: 'test-credential', name: 'Test', provider: 'openai', authMethod: 'api_key', apiKeyConfigured: true,
      supportsReasoning: true, reasoningEffortLevels: ['low', 'high'], reasoningDefaultEffort: 'low',
      modelOptions: [{ id: 'context', label: 'Context', kind: 'select', defaultValue: 'small', choices: [
        { value: 'small', label: '32K', contextWindow: 32768 },
        { value: 'large', label: '128K', contextWindow: 131072 },
      ] }],
      enabled: true, model, baseUrl: `http://127.0.0.1:${server.port}/v1`,
    })));
    await writeFile(configPath, config);
    const helperPath = path.join(home, 'credential-fixture');
    await writeFile(helperPath, '#!/bin/sh\nread request\nprintf \'%s\\n\' \'{"version":1,"ok":true,"data":{"secret":"local-only"}}\'\n', { mode: 0o700 });
    const command = process.env.PEER_ACP_TEST_BINARY ? [process.env.PEER_ACP_TEST_BINARY, 'acp'] : [process.execPath, new URL('../index.tsx', import.meta.url).pathname, 'acp'];
    const child = Bun.spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: {
      ...process.env, HOME: home, NO_PROXY: '*', no_proxy: '*', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
      PEER_MODEL_API_KEY: '', PEER_MODEL_ID: '', PEER_MODEL_BASE_URL: '', PEER_CREDENTIAL_HELPER_PATH: helperPath,
    } });
    const errors = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const timer = setTimeout(() => child.kill(), 15000);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    async function next(): Promise<any> {
      while (!buffer.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(await errors);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const end = buffer.indexOf('\n');
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      expect(value.jsonrpc).toBe('2.0');
      expect(value.error).toBeUndefined();
      return value;
    }
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      expect((await next()).id).toBe(1);
      const ids: string[] = [];
      for (let index = 0; index < 2; index++) {
        send({ jsonrpc: '2.0', id: index + 2, method: 'session/new', params: { cwd: workspaces[index], mcpServers: [] } });
        const created = (await next()).result;
        expect(created.configOptions[0].currentValue).toBe(acpModelId('test-credential', 'model-a'));
        expect(created.configOptions[0].options).toEqual([{ group: 'test-credential', name: 'Test', options: [
          { value: acpModelId('test-credential', 'model-a'), name: 'model-a' },
          { value: acpModelId('test-credential', 'model-b'), name: 'model-b' },
        ] }]);
        ids.push(created.sessionId);
      }
      expect(ids[0]).not.toBe(ids[1]);
      send({ jsonrpc: '2.0', id: 4, method: 'session/set_config_option', params: { sessionId: ids[0], configId: 'model', value: acpModelId('test-credential', 'model-b') } });
      const changed = await next();
      expect(changed.id).toBe(4);
      expect(changed.result.configOptions[0].currentValue).toBe(acpModelId('test-credential', 'model-b'));
      for (const [configId, value] of [['reasoning_effort', 'high'], ['context_window', JSON.stringify('large')]]) {
        send({ jsonrpc: '2.0', id: 5, method: 'session/set_config_option', params: { sessionId: ids[0], configId, value } });
        const selected = await next();
        expect(selected.result.configOptions.find((option: any) => option.id === configId).currentValue).toBe(value);
      }
      ids.forEach((sessionId, index) => send({ jsonrpc: '2.0', id: index + 10, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: index ? 'SESSION_B' : 'SESSION_A' }] } }));
      const approvals: any[] = [];
      const completed = new Set<number>();
      while (completed.size < 2) {
        const message = await next();
        if (message.method === 'session/request_permission') {
          approvals.push(message);
          if (approvals.length === 2) {
            for (const approval of [...approvals].reverse()) {
              const index = ids.indexOf(approval.params.sessionId);
              expect(index).toBeGreaterThanOrEqual(0);
              expect(approval.params.toolCall.toolCallId).toBe(`write-${index}`);
              send({ jsonrpc: '2.0', id: approval.id, result: { outcome: { outcome: 'selected', optionId: decisions[index] } } });
            }
          }
        } else if (message.id === 10 || message.id === 11) {
          expect(message.result.stopReason).toBe('end_turn'); completed.add(message.id);
        } else if (message.method === 'session/update') {
          expect(ids).toContain(message.params.sessionId);
        }
      }
      expect(approvals.length).toBe(2);
      expect(requestedModels[0]!.length).toBeGreaterThan(0);
      expect(requestedModels[1]!.length).toBeGreaterThan(0);
      expect(requestedModels[0]!.every((model) => model === 'model-b')).toBe(true);
      expect(requestedModels[1]!.every((model) => model === 'model-a')).toBe(true);
      expect(requestedEfforts[0]!.every((effort) => effort === 'high')).toBe(true);
      expect(requestedEfforts[1]!.every((effort) => effort === 'low')).toBe(true);
      expect(await readFile(configPath, 'utf8')).toBe(config);
      for (let index = 0; index < 2; index++) {
        expect(await readFile(path.join(workspaces[index]!, 'result.txt'), 'utf8').catch(() => null)).toBe(decisions[index] === 'allow-once' ? `SESSION_${index}` : null);
      }
      child.stdin.end(); expect(await child.exited).toBe(0);
    } finally {
      clearTimeout(timer); child.kill(); await child.exited;
      reader.releaseLock(); server.stop(true); await rm(home, { recursive: true, force: true });
    }
  }, 20000);
}
