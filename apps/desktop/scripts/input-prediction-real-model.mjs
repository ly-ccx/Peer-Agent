import assert from 'node:assert/strict';
import electron from 'electron';
import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProviderTextInference, createInputPredictionService } from '@peer-agent/runtime-node/models';
import { assembleSystemContext, createPromptSourceRegistry, createInputPredictionPromptSource } from '@peer-agent/system-context';
import { createDesktopModelCredentialClient } from '../electron/main/model-credential-client.mjs';
import { createLlmConfigStore } from '../electron/main/llm-config-store.mjs';
import { resolveChannel } from '../electron/main/provider-channels.mjs';

async function run() {
// Explicit model only; reads a credential through the existing helper. Never writes
// to the user's settings, credential store, conversations or runtime instances.
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const providerId = option('--provider');
assert.ok(providerId, '--provider is required');
const home = option('--data-home') ?? path.join(os.homedir(), '.peer-agent');
const output = option('--output') ?? path.join(mkdtempSync(path.join(os.tmpdir(), 'peer-prediction-live-')), 'machine.json');
const temp = mkdtempSync(path.join(os.tmpdir(), 'peer-prediction-config-'));
const timeoutMs = Number(option('--timeout-ms') ?? 2000);
copyFileSync(path.join(home, 'llm-providers.json'), path.join(temp, 'llm-providers.json'));
const credentials = createDesktopModelCredentialClient({ dataHome: home });
const models = createLlmConfigStore({ configFile: path.join(temp, 'llm-providers.json'), credentialDataHome: home, credentialClient: {
  getSecret: key => credentials.getSecret(key),
  setSecret() { throw Error('READ_ONLY_CREDENTIALS'); }, deleteSecret() { throw Error('READ_ONLY_CREDENTIALS'); },
} });
const provider = models.listProviders().find(row => row.id === providerId);
assert.ok(provider && (provider.authMethod ?? 'api_key') === 'api_key', 'Use an explicitly chosen API-key model; OAuth refresh writes are excluded');
const route = { ok: true, provider, selection: { modelProviderId: provider.id, reasoningEffort: 'off' } };
const context = assembleSystemContext({ mode: 'input_prediction' }, { registry: createPromptSourceRegistry({ sources: [createInputPredictionPromptSource()] }) });
const usage = [], results = [];
let clock = Date.now();
const infer = createProviderTextInference({ resolveCredential: (value, signal) => models.resolveCredentialAsync(value, signal), resolveChannel, fetchImpl: electron.net ? (...args) => electron.net.fetch(...args) : fetch });
const service = createInputPredictionService({ timeoutMs, now: () => clock, readSnapshot: () => ({ token: 'synthetic-stable', route,
  settings: { inputPrediction: { schemaVersion: 1, enabled: true, continuationEnabled: true } },
  messages: [{ role: 'user', content: '帮我修改一篇介绍自己项目经历的文章，先不发布。' },
    { role: 'assistant', content: '已修改文章，保留技术细节，并调整为分享个人理解的口吻。第三段到技术部分的过渡可以继续润色。' }] }),
  assemble: () => context, infer, budget: { reserve: () => ({}), settle: (_reservation, value, meta) => usage.push({ value, ...meta }) } });
try {
  for (const [mode, draftText] of [['next_turn', ''], ['continuation', '再帮我']]) {
    const started = performance.now();
    const result = await service.request(1, { requestId: crypto.randomUUID(), workspaceId: 'synthetic', conversationId: 'synthetic',
      composerInstanceId: mode, surface: 'desktop_bot', mode, draftVersion: 1, draftText,
      selectionStart: draftText.length, selectionEnd: draftText.length });
    results.push({ mode, durationMs: Math.round(performance.now() - started), result }); clock += 4000;
  }
} finally { service.dispose(); }
const report = { model: provider.model, providerId, wire: resolveChannel(provider).wire, syntheticContextOnly: true,
  existingProfileReadOnly: true, timeoutMs, transport: electron.net ? 'Electron net' : 'Node fetch', results, usage, passed: results.every(row => row.result.kind === 'candidate') };
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;

if (electron.app) electron.app.exit(report.passed ? 0 : 1);

}
if (electron.app) {
  electron.app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'peer-prediction-live-profile-')));
  electron.app.whenReady().then(run).catch(() => { console.error('REAL_MODEL_PROBE_UNAVAILABLE'); electron.app.exit(1); });
} else await run();
