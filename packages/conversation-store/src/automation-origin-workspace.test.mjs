import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createConversationStore } from './index.mjs';

let dir;
let store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'peer-automation-origin-workspace-'));
  store = createConversationStore({ storeDir: dir });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('Automation worktree conversations are listed under their origin workspace', () => {
  const conversation = store.createConversation({
    title: 'Automation: Daily review',
    workspacePath: '/tmp/automation-worktrees/run-1',
    automationOrigin: {
      kind: 'automation_run',
      automationId: 'automation-1',
      runId: 'run-1',
      automationName: 'Daily review',
      triggerSource: 'manual',
      originWorkspacePath: '/tmp/peer-knowledge',
      createdAt: '2026-08-06T00:00:00.000Z',
    },
  });

  const originItems = store.listConversationsByWorkspace('/tmp/peer-knowledge');
  assert.deepEqual(originItems.map((item) => item.id), [conversation.id]);
  assert.equal(originItems[0].workspacePath, '/tmp/automation-worktrees/run-1');
  assert.equal(originItems[0].automationOrigin.originWorkspacePath, '/tmp/peer-knowledge');

  const executionItems = store.listConversationsByWorkspace('/tmp/automation-worktrees/run-1');
  assert.deepEqual(executionItems.map((item) => item.id), [conversation.id]);
});
