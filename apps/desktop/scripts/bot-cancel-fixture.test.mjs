import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { controlledCancelSession } from './bot-cancel-fixture.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(mode) {
  const root = mkdtempSync(path.join(tmpdir(), 'peer-cancel-handshake-')), file = path.join(root, 'command.json');
  let sessions = [{ sessionId: 's', status: 'waiting_user' }, { sessionId: 'other', status: 'running' }], changed = 0;
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const update = patch => writeFileSync(file, JSON.stringify({ ...read(), ...patch }));
  writeFileSync(file, JSON.stringify({ cancelMode: mode, cancelHandshake: true, cancelCalls: [] }));
  return { file, read, update, sessions: () => sessions, changes: () => changed,
    call: options => controlledCancelSession({ file, payload: { workspaceId: 'w', sessionId: 's' }, getSessions: () => sessions,
      setSessions: next => { sessions = next; }, queueChanged: () => changed++, ...options }),
    close: () => rmSync(root, { recursive: true, force: true }) };
}
test('driver handshake retains pending and stopping past the former timer windows, then finalizes only the target', async () => {
  const f = fixture('deferred-status');
  try {
    let settled = false; const pending = f.call().then(value => { settled = true; return value; });
    await sleep(700); assert.equal(settled, false); assert.equal(f.sessions()[0].status, 'waiting_user');
    assert.equal(f.read().cancelCalls.length, 1); assert.equal(f.changes(), 0);
    f.update({ cancelRelease: [1] }); assert.equal((await pending).session.status, 'stopping');
    await sleep(700); assert.equal(f.sessions()[0].status, 'stopping'); assert.equal(f.changes(), 1);
    f.update({ cancelFinalize: [1] });
    for (let n = 0; n < 100 && f.sessions()[0].status !== 'cancelled'; n++) await sleep(10);
    assert.equal(f.sessions()[0].status, 'cancelled'); assert.equal(f.sessions()[1].status, 'running'); assert.equal(f.changes(), 2);
  } finally { f.close(); }
});
test('failed receipt needs release and cannot cancel work; missing release has a bounded explicit failure', async () => {
  const f = fixture('fail');
  try {
    const pending = f.call(); f.update({ cancelRelease: [1] });
    assert.deepEqual(await pending, { ok: false, code: 'CONTROLLED_CANCEL_FAILURE' }); assert.equal(f.changes(), 0);
    await assert.rejects(f.call({ timeoutMs: 40 }), /Controlled cancellation 2 was not advanced/);
    assert.equal(f.sessions()[0].status, 'waiting_user'); assert.equal(f.read().cancelCalls.length, 2);
  } finally { f.close(); }
});
