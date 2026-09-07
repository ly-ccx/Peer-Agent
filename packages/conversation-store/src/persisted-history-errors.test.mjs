import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPersistedHistoryFiles } from './persisted-history.mjs';

const valid = JSON.stringify({ id: 'a', role: 'assistant', content: 'answer' });
for (const [name, history, sidecar, revision, code] of [
  ['new empty session', null, null, 0, null],
  ['missing recorded history', null, null, 1, 'BACKGROUND_HISTORY_MISSING'],
  ['empty recorded history', '', null, 1, 'BACKGROUND_HISTORY_CORRUPT'],
  ['truncated JSONL', valid + '\n{', null, 1, 'BACKGROUND_HISTORY_CORRUPT'],
  ['non-object row', 'null', null, 1, 'BACKGROUND_HISTORY_CORRUPT'],
  ['malformed sidecar', valid, '{', 1, 'BACKGROUND_STREAM_STATE_INVALID'],
  ['foreign sidecar', valid, JSON.stringify({ version: 1, conversationId: 'other', messageId: 'a', patch: {} }), 1, 'BACKGROUND_STREAM_STATE_INVALID'],
  ['unknown target', valid, JSON.stringify({ version: 1, conversationId: 'c', messageId: 'missing', patch: {} }), 1, 'BACKGROUND_STREAM_TARGET_MISSING'],
]) {
  test(`strict background: ${name}`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'peer-history-error-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const historyFile = join(dir, 'history');
    const sidecarFile = join(dir, 'sidecar');
    if (history !== null) writeFileSync(historyFile, history);
    if (sidecar !== null) writeFileSync(sidecarFile, sidecar);
    const read = () => readPersistedHistoryFiles({ historyFile, sidecarFile, conversationId: 'c', contentRevision: revision });
    if (code) assert.throws(read, { code });
    else assert.deepEqual(read().messages, []);
  });
}
