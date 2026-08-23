import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createConversationStore } from './index.mjs';

let dir;
let store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'peer-preferred-isolation-'));
  store = createConversationStore({ storeDir: dir });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('preferred worktree isolation persists across store reopen', () => {
  const created = store.createConversation({
    title: 'Isolated task',
    preferredExecutionIsolation: 'worktree',
  });
  assert.equal(created.preferredExecutionIsolation, 'worktree');
  assert.equal(store.getConversation(created.id).preferredExecutionIsolation, 'worktree');

  const reopened = createConversationStore({ storeDir: dir });
  assert.equal(reopened.getConversation(created.id).preferredExecutionIsolation, 'worktree');
});

test('legacy conversations without the field reopen as none', () => {
  const created = store.createConversation({ title: 'Legacy task' });
  assert.equal(created.preferredExecutionIsolation, 'none');

  const indexPath = join(dir, 'index.jsonl');
  const rows = readFileSync(indexPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  delete rows[0].preferredExecutionIsolation;
  writeFileSync(indexPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const reopened = createConversationStore({ storeDir: dir });
  assert.equal(reopened.getConversation(created.id).preferredExecutionIsolation, 'none');
});

test('unknown isolation values normalize to none', () => {
  const created = store.createConversation({
    title: 'Odd task',
    preferredExecutionIsolation: 'stash',
  });
  assert.equal(created.preferredExecutionIsolation, 'none');
});
