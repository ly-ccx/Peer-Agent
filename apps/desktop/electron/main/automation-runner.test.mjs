import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAutomationRunner } from './automation-runner.mjs';

function fixture() {
  const runs = new Map();
  const conversations = [];
  const messages = [];
  runs.set('run-1', {
    runId: 'run-1', automationId: 'a-1', status: 'queued', idempotencyKey: 'a-1:now',
    triggerSource: 'scheduled', scheduledAt: '2026-08-04T00:00:00.000Z', createdAt: '2026-08-04T00:00:00.000Z',
    attentionVersion: 0,
    snapshot: {
      definitionVersion: 1, name: 'Review', prompt: 'Review the repository', workspacePath: '/workspace',
      modelProviderId: 'provider-1', schedule: { kind: 'daily', timezone: 'UTC' }, budget: {},
      grant: { preset: 'observe', workspacePath: '/workspace', allowedCapabilityIds: [], askCapabilityIds: [], blockedCapabilityIds: ['local.file.write'], confirmedAt: '2026-08-04T00:00:00.000Z', version: 1 },
    },
  });
  const store = {
    getRun: (id) => structuredClone(runs.get(id)),
    updateRun(id, patch) { const next = { ...runs.get(id), ...structuredClone(patch) }; runs.set(id, next); return structuredClone(next); },
  };
  const conversationStore = {
    createConversation(input) { const value = { id: 42, ...input }; conversations.push(value); return value; },
    appendMessage(id, message) { messages.push({ id, message }); },
  };
  return { runs, store, conversations, messages, conversationStore };
}

describe('automation runner', () => {
  it('creates a Fresh Conversation and passes a request-scoped grant to the real agent seam', async () => {
    const state = fixture();
    const calls = [];
    const runner = createAutomationRunner({
      store: state.store,
      conversationStore: state.conversationStore,
      ensureWorkspace: async () => {},
      createId: (() => { let id = 0; return () => `id-${++id}`; })(),
      now: (() => { const values = ['2026-08-04T00:00:01.000Z', '2026-08-04T00:00:03.000Z']; return () => values.shift(); })(),
      llmChatService: { async sendMessage(input) { calls.push(input); return { terminalStatus: 'done', evidenceRefs: ['evidence://1'] }; } },
    });

    const result = await runner.run('run-1');
    assert.equal(result.status, 'succeeded');
    assert.equal(result.conversationId, 42);
    assert.equal(state.conversations.length, 1);
    assert.equal(state.messages.length, 2);
    assert.equal(calls[0].permissionPolicy.kind, 'automation');
    assert.equal(calls[0].permissionPolicy.preset, 'observe');
    assert.equal(calls[0].webContents.isDestroyed(), false);
    assert.deepEqual(result.receipt.evidenceRefs, ['evidence://1']);
  });

  it('runs write grants inside the prepared worktree and persists change evidence', async () => {
    const state = fixture();
    state.runs.get('run-1').snapshot.grant = {
      ...state.runs.get('run-1').snapshot.grant,
      preset: 'work_in_workspace',
      allowedCapabilityIds: ['local.file.write'],
      blockedCapabilityIds: [],
    };
    const lifecycle = [];
    const calls = [];
    const worktreeAdapter = {
      async prepare() {
        lifecycle.push('prepare');
        return {
          kind: 'worktree',
          workspacePath: '/isolated/run-1',
          baseline: { commit: 'abc123', branch: 'main', dirty: true },
        };
      },
      async collect() {
        lifecycle.push('collect');
        return {
          worktreePath: '/isolated/run-1',
          branch: 'PeerAgent/automation-a-1/run-run-1',
          changedFiles: ['src/a.ts'], additions: 2, deletions: 1,
          diffArtifactRefs: ['automation-artifact://run-1/changes.patch'], retained: true,
        };
      },
      async retainOrCleanup(_run, _execution, changes) {
        lifecycle.push('retain');
        return changes;
      },
    };
    const runner = createAutomationRunner({
      store: state.store,
      conversationStore: state.conversationStore,
      worktreeAdapter,
      ensureWorkspace: async () => {},
      now: (() => { const values = ['2026-08-04T00:00:01.000Z', '2026-08-04T00:00:03.000Z']; return () => values.shift(); })(),
      llmChatService: { async sendMessage(input) { calls.push(input); return { terminalStatus: 'done' }; } },
    });

    const result = await runner.run('run-1');
    assert.equal(calls[0].workspacePath, '/isolated/run-1');
    assert.equal(state.conversations[0].workspacePath, '/isolated/run-1');
    assert.deepEqual(lifecycle, ['prepare', 'collect', 'retain']);
    assert.equal(result.snapshot.gitBaseline.commit, 'abc123');
    assert.deepEqual(result.receipt.changes.changedFiles, ['src/a.ts']);
    assert.deepEqual(result.receipt.evidenceRefs, ['automation-artifact://run-1/changes.patch']);
  });

  it('persists workspace failures without invoking the model', async () => {
    const state = fixture();
    let called = false;
    const runner = createAutomationRunner({
      store: state.store,
      conversationStore: state.conversationStore,
      ensureWorkspace: async () => { throw new Error('workspace_missing'); },
      now: () => '2026-08-04T00:00:02.000Z',
      llmChatService: { async sendMessage() { called = true; } },
      logger: { error() {} },
    });
    const result = await runner.run('run-1');
    assert.equal(result.status, 'failed');
    assert.equal(result.failureReason, 'workspace_missing');
    assert.equal(called, false);
  });
});
