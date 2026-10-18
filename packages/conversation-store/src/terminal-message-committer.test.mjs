import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConversationStore } from './index.mjs';
import { createTerminalMessageCommitter, conversationFileVersion } from './terminal-message-committer.mjs';

function world(t) {
  const dir = mkdtempSync(join(tmpdir(), 'peer-terminal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: dir }), convo = store.createConversation({ title: 'fixture' });
  store.appendMessage(convo.id, { id: 'answer', role: 'assistant', content: '' });
  return { dir, store, id: convo.id, file: join(dir, convo.id + '.jsonl') };
}
test('terminal commit stays provisional until durable, then reads normally and cleans its sidecar', async t => {
  const w = world(t); w.store.patchStreamingMessage(w.id, 'answer', { content: 'partial' });
  const change = readFileSync(join(w.dir, '.changes.json'), 'utf8');
  const patch = { content: 'final', interrupted: false, segments: [{ type: 'text', content: 'final' }] };
  const committed = w.store.commitStreamingMessage(w.id, 'answer', patch); patch.content = 'mutated caller';
  assert.equal(readFileSync(join(w.dir, '.changes.json'), 'utf8'), change);
  assert.equal(w.store.getPersistedConversationHistory(w.id).messages.length, 0);
  const receipt = await committed;
  assert.equal(receipt.messageId, 'answer'); assert.ok(receipt.contentRevision > 1);
  assert.equal('messages' in receipt, false, 'do not transfer the whole history to the main thread');
  assert.equal(w.store.getPersistedConversationHistory(w.id).messages[0].content, 'final');
  assert.equal(existsSync(join(w.dir, w.id + '.stream.json')), false);
  assert.equal(JSON.parse(readFileSync(w.file, 'utf8').trim()).content, 'final', 'legacy JSONL readers see the committed terminal');
});
test('concurrent append and same-session terminal updates preserve ordering and every message', async t => {
  const w = world(t);
  const first = w.store.commitStreamingMessage(w.id, 'answer', { content: 'one' });
  w.store.appendMessage(w.id, { id: 'new-user', role: 'user', content: 'next input' });
  const second = w.store.commitStreamingMessage(w.id, 'answer', { content: 'two' });
  await Promise.all([first, second]);
  const messages = w.store.getConversation(w.id).messages;
  assert.deepEqual(messages.map(m => m.id), ['answer', 'new-user']); assert.equal(messages[0].content, 'two');
});
test('a version conflict prepares again from current history; the rejected candidate never overwrites append', async t => {
  const w = world(t); let attempts = 0;
  const committer = createTerminalMessageCommitter({ storeDir: w.dir, commitPrepared: p => {
    attempts++;
    if (attempts === 1) w.store.appendMessage(w.id, { id: 'late', role: 'user', content: 'retain' });
    if (conversationFileVersion(p.historyFile) !== p.sourceVersion) return false;
    renameSync(p.temporaryFile, p.historyFile); return { committed: true };
  } });
  assert.equal((await committer.commit(w.id, 'answer', { content: 'ready' })).committed, true);
  assert.equal(attempts, 2); assert.deepEqual(w.store.getConversation(w.id).messages.map(m => m.id), ['answer', 'late']);
  assert.equal(readdirSync(w.dir).some(f => f.endsWith('.tmp')), false);
});
test('deleted or replaced targets cannot be resurrected and a corrupt history cannot be silently rewritten', async t => {
  const w = world(t); w.store.patchStreamingMessage(w.id, 'answer', { content: 'recoverable' });
  w.store.replaceMessages(w.id, [{ id: 'different', role: 'assistant', content: 'keep' }]);
  await assert.rejects(w.store.commitStreamingMessage(w.id, 'answer', { content: 'wrong' }), { code: 'CONVERSATION_MESSAGE_MISSING' });
  assert.equal(w.store.getConversation(w.id).messages[0].content, 'keep');
  writeFileSync(w.file, '{broken');
  await assert.rejects(w.store.commitStreamingMessage(w.id, 'answer', { content: 'wrong' }), { code: 'CONVERSATION_HISTORY_CORRUPT' });
  assert.equal(readFileSync(w.file, 'utf8'), '{broken');
  assert.equal(existsSync(join(w.dir, w.id + '.stream.json')), true);
});
test('timeout terminates preparation, leaves recoverable facts and cleans owned temporary files', async t => {
  const w = world(t); let commits = 0;
  const committer = createTerminalMessageCommitter({ storeDir: w.dir, timeoutMs: 1, commitPrepared: () => { commits++; } });
  await assert.rejects(committer.commit(w.id, 'answer', { content: 'late' }), { code: 'CONVERSATION_COMMIT_TIMEOUT' });
  assert.equal(commits, 0); assert.equal(w.store.getConversation(w.id).messages[0].content, '');
  assert.equal(readdirSync(w.dir).some(f => f.endsWith('.tmp')), false);
});
test('large terminal preparation allows the event loop to run and produces a byte-readable result', async t => {
  const w = world(t);
  w.store.replaceMessages(w.id, [{ id: 'old', role: 'user', content: 'history'.repeat(1_000_000) }, { id: 'answer', role: 'assistant', content: '' }]);
  let beats = 0; const timer = setInterval(() => beats++, 2);
  try { await w.store.commitStreamingMessage(w.id, 'answer', { content: 'done' }); }
  finally { clearInterval(timer); }
  assert.ok(beats > 2, 'preparation must yield to input/timers instead of synchronously reading and encoding the history');
  assert.equal(w.store.getConversation(w.id).messages.at(-1).content, 'done');
});

test('deletion during preparation never recreates a history or index row', async t => {
  const w = world(t), pending = w.store.commitStreamingMessage(w.id, 'answer', { content: 'late' });
  w.store.deleteConversation(w.id);
  await assert.rejects(pending, error => ['ENOENT', 'CONVERSATION_COMMIT_DELETED'].includes(error.code));
  assert.equal(existsSync(w.file), false); assert.equal(w.store.listConversations().length, 0);
});
test('another process append is retained when the prepared version is rejected', async t => {
  const { execFileSync } = await import('node:child_process');
  const w = world(t); let attempts = 0;
  const committer = createTerminalMessageCommitter({ storeDir: w.dir, commitPrepared: p => {
    if (++attempts === 1) execFileSync(process.execPath, ['--input-type=module', '-e',
      `import {createConversationStore} from ${JSON.stringify(new URL('./index.mjs', import.meta.url).href)};
       createConversationStore({storeDir:process.argv[1]}).appendMessage(process.argv[2],{id:'external',role:'user',content:'new input'});`, w.dir, w.id]);
    if (conversationFileVersion(p.historyFile) !== p.sourceVersion) return false;
    renameSync(p.temporaryFile, p.historyFile); return {};
  } });
  await committer.commit(w.id, 'answer', { content: 'ready' });
  assert.equal(attempts, 2); assert.deepEqual(w.store.getConversation(w.id).messages.map(m => m.id), ['answer', 'external']);
});
test('a process crash after preparation cannot publish its uncommitted candidate', async t => {
  const { spawn } = await import('node:child_process');
  const w = world(t); w.store.patchStreamingMessage(w.id, 'answer', { content: 'partial survives' });
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import {createTerminalMessageCommitter} from ${JSON.stringify(new URL('./terminal-message-committer.mjs', import.meta.url).href)};
     await createTerminalMessageCommitter({storeDir:process.argv[1],commitPrepared(){process.kill(process.pid,'SIGKILL');}}).commit(process.argv[2],'answer',{content:'uncommitted'});`, w.dir, w.id], { stdio: 'ignore' });
  await new Promise(resolve => child.once('exit', resolve));
  const reopened = createConversationStore({ storeDir: w.dir });
  assert.equal(JSON.parse(readFileSync(w.file, 'utf8')).content, '');
  assert.equal(reopened.getConversation(w.id).messages[0].content, 'partial survives');
  await reopened.commitStreamingMessage(w.id, 'answer', { content: 'recovered', interrupted: false });
  assert.equal(reopened.getConversation(w.id).messages[0].content, 'recovered');
});
