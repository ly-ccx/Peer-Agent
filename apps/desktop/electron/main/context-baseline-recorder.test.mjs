import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createContextBaselineRecorder } from './prompt/context-baseline-recorder.mjs';
import { createPromptSnapshotStore } from './prompt/prompt-snapshot-store.mjs';

function withTempDir(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-agent-context-baseline-'));
  try {
    return callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Context baseline recorder', () => {
  it('records a provider baseline with workspace and provider metadata', () => withTempDir((storeDir) => {
    const store = createPromptSnapshotStore({
      storeDir,
      clock: () => new Date('2026-06-10T00:00:00.000Z'),
    });
    const recorder = createContextBaselineRecorder({
      promptSnapshotStore: store,
      getWorkspacePath: () => '/tmp/workspace',
    });

    const entry = recorder.recordProviderBaseline({
      reason: 'model_switch',
      provider: {
        id: 'provider-1',
        provider: 'openai',
        model: 'gpt-test',
      },
    });

    assert.match(entry.baselineId, /^prompt-baseline-/);
    assert.match(entry.contextEpochId, /^context-epoch-/);
    assert.equal(entry.workspacePath, '/tmp/workspace');
    assert.equal(entry.provider, 'openai');
    assert.equal(entry.providerId, 'provider-1');
    assert.equal(entry.model, 'gpt-test');
    assert.equal(store.getLatestContextEpoch().contextEpochId, entry.contextEpochId);
  }));

  it('skips recording when no provider is available', () => {
    const recorder = createContextBaselineRecorder({
      promptSnapshotStore: {
        recordBaseline() {
          throw new Error('should not be called');
        },
      },
    });

    assert.equal(recorder.recordProviderBaseline(), null);
  });

  it('records configured instruction baselines as project instruction context', () => withTempDir((storeDir) => {
    const store = createPromptSnapshotStore({
      storeDir,
      clock: () => new Date('2026-06-10T00:00:00.000Z'),
    });
    const recorder = createContextBaselineRecorder({
      promptSnapshotStore: store,
      getWorkspacePath: () => '/tmp/workspace',
    });

    const entry = recorder.recordConfiguredInstructionsBaseline({
      instructions: 'Prefer short answers.',
      provider: {
        id: 'provider-1',
        provider: 'openai',
        model: 'gpt-test',
      },
    });

    const record = store.get(entry.id);
    assert.equal(entry.baselineReason, 'instruction_change');
    assert.equal(record.context.rendered.includes('Prefer short answers.'), true);
    assert.equal(record.context.snapshot.sectionRefs.some((section) => section.id.startsWith('project.instructions.config.')), true);
  }));
});
