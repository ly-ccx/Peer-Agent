import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { withFileLocksAsync } from './conversation-file-lock.mjs';
import { createConversationStore } from './index.mjs';

function fixture(t) {
  const storeDir = mkdtempSync(join(tmpdir(), 'peer-conversation-retention-'));
  t.after(() => rmSync(storeDir, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir });
  const { id } = store.createConversation({ title: 'original' });
  const anchor = { id: 'anchor', role: 'user', content: 'canonical input', attachments: [{ type: 'text', text: 'opaque carrier' }] };
  store.appendMessage(id, anchor);
  return { storeDir, store, id, anchor, indexFile: join(storeDir, 'index.jsonl') };
}

test('a metadata writer in another process waits for the Conversation retention guard', { timeout: 7000 }, async t => {
  const { storeDir, store, id, anchor, indexFile } = fixture(t);
  const guard = store.acquireMessageRetentionGuard([id]);
  const readAt = new Date(Date.parse(store.getConversation(id).lastReadAt) + 1000).toISOString();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const [storeDir, id, lock, readAt] = process.argv.slice(1);
    const mkdir = fs.mkdirSync;
    let notified = false;
    fs.mkdirSync = (file, ...options) => {
      try { return mkdir(file, ...options); }
      catch (error) {
        if (file === lock && error.code === 'EEXIST' && !notified) {
          notified = true;
          process.send('waiting');
        }
        throw error;
      }
    };
    syncBuiltinESMExports();
    const { createConversationStore } = await import(${JSON.stringify(new URL('./index.mjs', import.meta.url).href)});
    const store = createConversationStore({ storeDir });
    store.updateTitle(id, 'renamed');
    store.markRead(id, { at: readAt });
    process.disconnect();
  `, storeDir, id, `${indexFile}.lock`, readAt], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    assert.equal(await Promise.race([
      once(child, 'message').then(([message]) => message),
      exited.then(([code]) => `exited (${code})`),
    ]), 'waiting');
    assert.equal(guard.assertCurrent(), true);
    assert.equal(store.getConversation(id).title, 'original');
    assert.deepEqual(guard.histories.get(id), [anchor]);
  } finally {
    guard.release();
    await exited;
  }
  assert.equal(child.exitCode, 0);
  assert.equal(store.getConversation(id).title, 'renamed');
  assert.equal(store.getConversation(id).lastReadAt, readAt);
  assert.deepEqual(store.getPersistedConversationHistory(id).messages, [anchor]);
});

test('background backfill preserves metadata and waits while the retention guard owns the index', { timeout: 3000 }, async t => {
  const { store, id, indexFile } = fixture(t);
  const readMeta = () => JSON.parse(readFileSync(indexFile, 'utf8'));
  const legacy = readMeta();
  delete legacy.messageCount;
  writeFileSync(indexFile, JSON.stringify(legacy) + '\n');
  const guard = store.acquireMessageRetentionGuard([id]);
  try {
    store.listConversations();
    await delay(25);
    assert.equal(readMeta().messageCount, undefined);
    assert.equal(guard.assertCurrent(), true);
  } finally { guard.release(); }
  store.updateTitle(id, 'metadata written before migration retry');
  for (let attempt = 0; attempt < 100 && readMeta().messageCount === undefined; attempt++) await delay(10);
  assert.equal(readMeta().messageCount, 1);
  assert.equal(readMeta().title, 'metadata written before migration retry');
});

test('an asynchronous terminal lock retry leaves the index available to synchronous metadata writers', async t => {
  const { storeDir, store, id, indexFile } = fixture(t);
  const historyFile = join(storeDir, `${id}.jsonl`);
  mkdirSync(`${historyFile}.lock`);
  const result = withFileLocksAsync([indexFile, historyFile], () => store.getConversation(id).title);
  try {
    assert.equal(existsSync(`${indexFile}.lock`), false);
    assert.equal(store.updateTitle(id, 'renamed while terminal waits').title, 'renamed while terminal waits');
  } finally {
    rmSync(`${historyFile}.lock`, { recursive: true, force: true });
    await result;
  }
  assert.equal(await result, 'renamed while terminal waits');
});
