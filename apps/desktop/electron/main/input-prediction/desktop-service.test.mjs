import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDesktopInputPrediction } from './desktop-service.mjs';
import { createUsageRequestLog } from '../usage-request-log.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'peer-prediction-host-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sender = new EventEmitter(); sender.id = 1;
  const settings = { workspaces: [{ id: 'w', path: directory }],
    inputPrediction: { enabled: true, continuationEnabled: true },
    modelRouting: { roles: { input_predictor: { mode: 'fixed', modelProviderId: 'p' } } } };
  const meta = { id: 'c', workspacePath: directory, contentRevision: 1 };
  const history = { messages: [{ id: 'u', role: 'user', kind: 'user_input', content: '修改文章，先不发布。' },
    { id: 'private', role: 'assistant', kind: 'agent_turn', content: 'HIDDEN_TOOL_SECRET' },
    { id: 'a', role: 'assistant', kind: 'agent_reply', content: '已修改文章。' }] };
  const bodies = []; let onChange = () => {};
  const bot = { ok: true, path: directory, profile: { agentConversationId: 'c' }, item: { state: { needsYou: 0 } } };
  const service = createDesktopInputPrediction({ getSettings: () => settings,
    listModels: () => [{ id: 'p', model: 'fixture', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1',
      enabled: true, apiKeyConfigured: true, supportsTools: false, contextWindow: 8192 }],
    conversationStore: { listConversations: () => [meta], getPersistedConversationHistory: () => history,
      subscribeChanges(listener) { onChange = listener; return () => {}; } },
    getProjectAgent: () => ({ projectAccess: { directory: { get: () => bot } } }),
    llmConfigStore: { getDecryptedApiKey: () => 'fixture-key' },
    trustedWindows: { getRole: value => value === sender ? 'main' : null },
    usageLog: createUsageRequestLog({ logFile: path.join(directory, 'usage.jsonl') }),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"kind":"next_turn","text":"检查一下过渡。"}' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
    },
  });
  t.after(service.dispose);
  const request = { requestId: 'r', composerInstanceId: 'i', workspaceId: 'w', conversationId: 'c',
    surface: 'desktop_classic', mode: 'next_turn', draftVersion: 1, draftText: '', selectionStart: 0, selectionEnd: 0 };
  return { service, sender, settings, meta, history, bodies, bot, request, publish: event => onChange(event) };
}

test('production host builds a bounded public-only Context and never admits private turns or credentials', async t => {
  const f = fixture(t), result = await f.service.request(f.request, f.sender);
  assert.equal(result.kind, 'candidate'); assert.equal(f.bodies.length, 1);
  const body = JSON.stringify(f.bodies[0]);
  assert.match(body, /修改文章/); assert.doesNotMatch(body, /HIDDEN_TOOL_SECRET|fixture-key/);
  assert.ok(!f.bodies[0].tools?.length);
  assert.equal(f.service.status(f.sender).requests, 1);
});

test('untrusted windows, cross-workspace conversations and read-only task surfaces cannot request a prediction', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.request(f.request, { id: 2 }), /UNTRUSTED/);
  assert.notEqual((await f.service.request({ ...f.request, workspaceId: 'other' }, f.sender)).kind, 'candidate');
  f.meta.role = 'work_session';
  assert.notEqual((await f.service.request(f.request, f.sender)).kind, 'candidate');
  assert.equal(f.bodies.length, 0);
});

test('explicit role selection is required; current Bot decisions suspend the real prediction service', async t => {
  const f = fixture(t);
  delete f.settings.modelRouting.roles.input_predictor;
  assert.equal((await f.service.request(f.request, f.sender)).reason, 'model_unconfigured');
  f.settings.modelRouting.roles.input_predictor = { mode: 'fixed', modelProviderId: 'p' };
  f.bot.item.state.needsYou = 1;
  assert.equal((await f.service.request({ ...f.request, surface: 'desktop_bot' }, f.sender)).reason, 'decision_or_reply');
  assert.equal(f.bodies.length, 0);
});

test('policy and source revisions invalidate accepted references, even without a new message id', async t => {
  const f = fixture(t), result = await f.service.request(f.request, f.sender);
  f.settings.inputPrediction.enabled = false;
  const reference = { ...f.request, candidateId: result.candidate.candidateId };
  assert.equal((await f.service.validate(reference, f.sender)).kind, 'stale');
  assert.equal(f.service.status(f.sender).reason, 'disabled');
});


test('the real ConversationChangeEvent changeType retires a candidate before acceptance', async t => {
  const f = fixture(t), result = await f.service.request(f.request, f.sender);
  assert.equal(result.kind, 'candidate');
  f.publish({ conversationId: 'c', changeType: 'messages-updated', revision: 'new-revision' });
  assert.equal((await f.service.validate({ ...f.request, candidateId: result.candidate.candidateId }, f.sender)).kind, 'stale');
});
