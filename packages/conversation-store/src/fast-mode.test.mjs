import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createConversationStore } from './index.mjs';

let dir;
let store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'peer-fast-mode-'));
  store = createConversationStore({ storeDir: dir });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('fast mode persists across store reopen and can be updated', () => {
  const created = store.createConversation({ title: 'Fast task', fastMode: true });
  assert.equal(created.fastMode, true);
  assert.equal(store.getConversation(created.id).fastMode, true);

  const reopened = createConversationStore({ storeDir: dir });
  assert.equal(reopened.getConversation(created.id).fastMode, true);

  reopened.updateFastMode(created.id, false);
  assert.equal(createConversationStore({ storeDir: dir }).getConversation(created.id).fastMode, false);
});

test('legacy conversations without fastMode reopen as non-fast', () => {
  const created = store.createConversation({ title: 'Legacy task' });
  const indexPath = join(dir, 'index.jsonl');
  const rows = readFileSync(indexPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  delete rows[0].fastMode;
  writeFileSync(indexPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const reopened = createConversationStore({ storeDir: dir });
  assert.equal(reopened.getConversation(created.id).fastMode, false);
});

test('preferredExecutionIsolation can be updated after the conversation exists', () => {
  const created = store.createConversation({ title: 'pref' });
  assert.equal(created.preferredExecutionIsolation, 'none');
  const updated = store.updatePreferredExecutionIsolation(created.id, 'worktree');
  assert.equal(updated.preferredExecutionIsolation, 'worktree');
  const reopened = createConversationStore({ storeDir: dir });
  assert.equal(reopened.getConversation(created.id).preferredExecutionIsolation, 'worktree');
});
