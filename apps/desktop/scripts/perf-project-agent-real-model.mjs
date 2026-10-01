// Opt-in live cognition benchmark. Personal configuration is read, never updated.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { _electron } from 'playwright-core';
import { prepareLabIsolation } from './lab-workspace-isolate.mjs';
import { createOwnedProcessRegistry } from './lab-process-identity.mjs';
import { metric } from './perf-project-agent.mjs';

const valueOf = flag => { const index = process.argv.indexOf(flag); return index < 0 ? null : process.argv[index + 1]; };
const modelId = valueOf('--model-id');
assert.ok(modelId, 'Choose an existing configured model with --model-id');
const source = fileURLToPath(new URL('../../..', import.meta.url));
const original = path.join(os.homedir(), '.peer-agent');
const root = mkdtempSync(path.join(os.tmpdir(), 'peer-rc-live-model-'));
const home = path.join(root, 'data'), project = path.join(root, 'project');
mkdirSync(home); mkdirSync(project);
const report = { schemaVersion: 1, synthetic: false, installed: false, startedAt: new Date().toISOString(),
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim()),
  samples: [], pageErrors: [], scope: 'Source production Electron, project host, live configured fast model and real post_reply tool; submission to committed turn and anchored reply' };
const owned = createOwnedProcessRegistry(); let handle;
const until = async (read, predicate, timeout = 150000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw Error('Live model acceptance timed out');
};
try {
  const config = JSON.parse(readFileSync(path.join(original, 'llm-providers.json'), 'utf8'));
  const model = config.models.find(row => row.id === modelId);
  assert.ok(model, 'Configured model missing');
  const channel = config.channels.find(row => row.id === model.groupId);
  assert.ok(channel, 'Configured channel missing');
  report.model = model.model; report.provider = channel.provider;
  writeFileSync(path.join(home, 'llm-providers.json'), JSON.stringify({ version: config.version, channels: [channel], models: [{ ...model, isDefault: true }] }), { mode: 0o600 });
  for (const file of ['credentials.vault.json', 'device-identity.json']) if (existsSync(path.join(original, file))) cpSync(path.join(original, file), path.join(home, file));
  const settings = { schemaVersion: 3, locale: 'zh-CN', memory: { enabled: false }, localAccessLevel: 'restricted_local',
    workspaces: [{ path: project, name: 'RC live performance' }], projectAgent: { shell: 'bots', managedRoot: path.join(root, 'managed'), shellIntroDismissed: true },
    modelRouting: { tiers: Object.fromEntries(['strong', 'fast', 'economy', 'vision'].map(key => [key, { primary: model.id, fallbacks: [] }])) } };
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
  const isolation = prepareLabIsolation({ sourceRoot: source, labHome: home });
  cpSync(path.join(source, 'apps/desktop/dist'), isolation.launch.distDir, { recursive: true });
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
  const env = { ...process.env, PEER_AGENT_HOME: home, PEER_WORKSPACE_ROOT: project, PEER_AGENT_DISABLE_LEGACY_MIGRATION: '1',
    PEER_CREDENTIAL_HELPER_PATH: valueOf('--helper-path') || process.env.PEER_CREDENTIAL_HELPER_PATH || path.join(source, 'target/debug/peer-credential-helper') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [isolation.launch.desktopDir, `--user-data-dir=${path.join(root, 'chromium')}`], cwd: isolation.launch.desktopDir, env, timeout: 30000 });
  handle = owned.register({ process: app.process(), close: () => app.close() });
  const page = await until(() => app.windows().find(window => window.url().includes('/dist/index.html') && !window.url().includes('window=')), Boolean, 60000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  const listed = await until(() => page.evaluate(() => window.peerAgent.projectAgentList()), value => value.items?.length === 1, 30000);
  const bot = listed.items[0];
  const rows = () => {
    const file = path.join(home, 'conversations', bot.profile.agentConversationId + '.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  for (let i = 0; i < 5; i++) {
    const inputId = `rc-live-${i}`, marker = `RC_LIVE_REPLY_${i}`;
    const startedAt = new Date().toISOString();
    const start = performance.now();
    let sample;
    try {
      const receipt = await page.evaluate(params => window.peerAgent.projectAgentSubmitInput(params), { workspaceId: bot.workspaceId, inputId,
        text: `这是一轮简单连通测试。只调用 post_reply 回复 ${marker}。不读文件、不启动任务、不调用其他工具。`, surface: 'desktop' });
      assert.equal(receipt.ok, true);
      const reply = await until(rows, value => {
        if (value.some(row => row.card === 'agent_unavailable' && row.createdAt >= startedAt)) throw Error('Provider unavailable');
        return value.some(row => row.kind === 'agent_reply' && row.replyTo?.includes('input-' + inputId) && value.some(turn => turn.id === row.turnId));
      });
      const message = reply.find(row => row.kind === 'agent_reply' && row.replyTo?.includes('input-' + inputId));
      const turn = reply.find(row => row.id === message.turnId);
      assert.ok(turn?.rounds?.some(round => round.toolCalls?.some(call => call.name === 'post_reply')), 'Live turn must actually call post_reply');
      assert.ok(message.content.includes(marker));
      sample = { model: model.model, inputId, turnId: message.turnId, outcome: 'done', durationMs: performance.now() - start };
    } catch {
      sample = { model: model.model, inputId, outcome: 'failed', durationMs: performance.now() - start, code: 'LIVE_TURN_FAILED' };
    }
    report.samples.push(sample); console.log(JSON.stringify(sample));
  }
  report.metric = metric('realModel', report.samples.map(sample => sample.durationMs));
  report.ok = report.samples.every(sample => sample.outcome === 'done') && report.metric.pass && report.pageErrors.length === 0;
} catch {
  report.ok = false; report.error = 'Live benchmark setup or host failed';
} finally {
  if (handle) report.ownedStop = await owned.stop({ handleId: handle, reason: 'owned' });
  for (const file of ['credentials.vault.json', 'credentials.vault.lock', 'device-identity.json', 'llm-providers.json']) rmSync(path.join(home, file), { force: true });
  report.credentialCopiesRemoved = true; report.finishedAt = new Date().toISOString();
  const output = valueOf('--output'); if (output) writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, ...report }));
  if (!report.ok) process.exitCode = 1;
}
