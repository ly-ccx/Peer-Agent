import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationStore } from './index.mjs';

async function settle() {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
}

test('legacy previews rebuild in one index write and then stay ready', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'preview-rebuild-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: dir });
  const ids = [];
  for (let index = 0; index < 6; index += 1) {
    const created = store.createConversation({ title: `legacy ${index}` });
    store.appendMessage(created.id, {
      id: `m-${index}`,
      role: 'user',
      content: `excerpt ${index}`,
    }, { returnMessages: false });
    ids.push(created.id);
  }
  const indexFile = path.join(dir, 'index.jsonl');
  const stripped = readFileSync(indexFile, 'utf8').trim().split('\n').map((line) => {
    const row = JSON.parse(line);
    delete row.preview;
    return row;
  });
  writeFileSync(indexFile, `${stripped.map((row) => JSON.stringify(row)).join('\n')}\n`);

  const reopened = createConversationStore({ storeDir: dir });
  const originalRename = fs.renameSync;
  let indexWrites = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to) === indexFile) indexWrites += 1;
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const listed = reopened.listConversations().filter((row) => ids.includes(row.id));
  assert.equal(listed.length, ids.length);
  assert.equal(listed.every((row) => row.preview?.availability === 'rebuilding'), true);
  assert.equal(indexWrites, 0, 'list must not rewrite the index synchronously');

  await settle();
  const rebuilt = reopened.listConversations().filter((row) => ids.includes(row.id));
  assert.deepEqual(
    rebuilt.map((row) => [row.id, row.preview?.availability, row.preview?.excerpt]).sort(),
    ids.map((id, index) => [id, 'ready', `excerpt ${index}`]).sort(),
  );
  assert.equal(indexWrites, 1, 'one library rebuild writes index.jsonl once');

  const writesAfterReady = indexWrites;
  reopened.listConversations();
  await settle();
  assert.equal(indexWrites, writesAfterReady);
});
