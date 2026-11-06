import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync, linkSync, symlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RESOURCE_FILE_REPLACE_CAPABILITY as capabilityId, normalizeResourceFileReplacePreview } from '@peer-agent/protocol';
import { createLocalConditionalFileProvider } from './local-conditional-file-provider.mjs';
import { createLocalFileProvider } from './local-file-provider.mjs';
import { createResourceFileReplaceProjection } from './resource-file-replace-projection.mjs';
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-file-replace-'))), file = path.join(root, 'note.md');
  t.after(() => rmSync(root, { recursive: true, force: true })); writeFileSync(file, 'old\r\n中文😀\r\n');
  const before = readFileSync(file, 'utf8'), resourceId = hash('resource'), content = 'new\r\n中文😀\r\n';
  const target = { recipient: { workspaceId: 'bot', conversationId: 'conversation' }, reference: { workspaceId: 'bot', path: file }, base: { resourceId, contentVersion: hash(before) } };
  const call = { toolCallId: 'resource-edit:operation', capabilityId, arguments: { requestId: 'operation', target, content, proposedVersion: hash(content) } };
  const { projection } = createResourceFileReplaceProjection({ requestId: 'operation', conversationId: 'conversation' });
  let current = true, valid = true; const permissions = [];
  const approval = () => ({ granted: true, grant: { grantId: 'grant', toolCallId: call.toolCallId, granted: true, duration: 'once', scope: capabilityId, decidedAt: '2026-10-27T02:00:00Z' }, validate: () => valid });
  const context = { resourceEditProjection: projection, requestPermission: async request => { permissions.push(request); return approval(); } };
  const provider = createLocalConditionalFileProvider({ resolveTarget: async () => ({ ok: true, root, path: target.reference.path, resourceId, validate: () => current }), isIntentCurrent: () => current, ...options });
  return { root, file, before, target, content, call, context, provider, approval, permissions,
    run: () => provider.executeCapability({ call, projectionId: projection.projectionId, sessionId: projection.sessionId }, context),
    expire: () => { current = false; }, revoke: () => { valid = false; } };
}
test('actual versioned text replacement keeps inode/mode/CRLF and returns real grant, observation and bounded diff evidence', async t => {
  const f = fixture(t); chmodSync(f.file, 0o640); const before = statSync(f.file);
  const result = await f.run();
  assert.equal(readFileSync(f.file, 'utf8'), f.content); assert.equal(statSync(f.file).ino, before.ino); assert.equal(statSync(f.file).mode, before.mode);
  assert.ok(normalizeResourceFileReplacePreview(result.result.outputPreview));
  assert.equal(result.result.outputPreview.outcome, 'applied'); assert.equal(result.result.outputPreview.observedVersion, hash(f.content)); assert.equal(result.grant.grantId, 'grant');
  assert.equal(result.result.evidence.toolCallId, f.call.toolCallId); assert.equal(result.result.evidence.returnedToCloud, false); assert.ok(result.result.outputPreview.diffPreview.includes('+new\r'));
  assert.equal(f.permissions.length, 1); assert.equal(JSON.stringify(f.permissions).includes(f.content), false); assert.equal(f.permissions[0].args.proposedVersion, hash(f.content));
});
test('a renderer-like granted boolean without an actual host grant or validation cannot write', async t => {
  for (const decision of [{ granted: true }, { granted: true, grant: { grantId: 'forged', toolCallId: 'other', granted: true, scope: capabilityId, duration: 'once' }, validate: () => true }]) {
    const f = fixture(t); f.context.requestPermission = async () => decision; const result = await f.run();
    assert.equal(result.result.outputPreview.outcome, 'denied'); assert.equal(readFileSync(f.file, 'utf8'), f.before); assert.equal(result.grant.granted, false);
  }
});
test('actual policy/timeout denials retain their original negative Grant and reason; an empty scope can never authorize writes', async t => {
  for (const scope of [null, undefined]) {
    const f = fixture(t), grant = { grantId: 'actual-timeout', toolCallId: `chat-permission:${f.call.toolCallId}`, granted: false, duration: 'denied', scope, decidedAt: '2026-10-27T02:00:00Z' };
    f.context.requestPermission = async () => ({ granted: false, grant, reason: 'permission_timeout' });
    const result = await f.run(); assert.equal(result.grant.grantId, grant.grantId); assert.equal(result.grant.scope, scope); assert.equal(result.result.outputPreview.reason, 'permission_timeout');
    assert.equal(result.result.outputPreview.permissionCallId, grant.toolCallId); assert.equal(readFileSync(f.file, 'utf8'), f.before);
    const positive = fixture(t); positive.context.requestPermission = async () => ({ granted: true, grant: { ...grant, toolCallId: positive.call.toolCallId, granted: true, duration: 'once' }, validate: () => true });
    assert.equal((await positive.run()).result.outputPreview.outcome, 'denied'); assert.equal(readFileSync(positive.file, 'utf8'), positive.before);
  }
});
test('missing projection, changed payload and expired source fail before any permission request or mutation', async t => {
  const a = fixture(t); delete a.context.resourceEditProjection; assert.equal((await a.run()).result.outputPreview.outcome, 'denied'); assert.equal(a.permissions.length, 0);
  const b = fixture(t); b.call.arguments.content = 'different'; assert.equal((await b.run()).result.outputPreview.reason, 'RESOURCE_EDIT_PAYLOAD_CHANGED'); assert.equal(b.permissions.length, 0);
  const c = fixture(t); c.expire(); assert.equal((await c.run()).result.outputPreview.outcome, 'denied'); assert.equal(c.permissions.length, 0); assert.equal(readFileSync(c.file, 'utf8'), c.before);
});
test('actual Reader missing-file, denied-scope and changed-source causes stay distinct before asking permission', async t => {
  for (const [code, outcome] of [['RESOURCE_EDIT_FILE_NOT_FOUND', 'failed'], ['RESOURCE_EDIT_SCOPE_DENIED', 'denied'], ['RESOURCE_EDIT_SOURCE_CHANGED', 'conflict']]) {
    const f = fixture(t, { resolveTarget: async () => ({ ok: false, code }) }), actual = await f.run();
    assert.equal(actual.result.outputPreview.reason, code); assert.equal(actual.result.outputPreview.outcome, outcome); assert.equal(f.permissions.length, 0); assert.equal(readFileSync(f.file, 'utf8'), f.before);
  }
});
test('version or source/policy changes during permission wait are rechecked instead of overwriting the latest file', async t => {
  for (const change of ['file', 'source', 'policy']) {
    const f = fixture(t); f.context.requestPermission = async () => { if (change === 'file') writeFileSync(f.file, 'external edit'); else if (change === 'source') f.expire(); else f.revoke(); return f.approval(); };
    const result = await f.run(); assert.equal(result.result.outputPreview.outcome, change === 'file' ? 'conflict' : 'denied');
    assert.equal(readFileSync(f.file, 'utf8'), change === 'file' ? 'external edit' : f.before); assert.equal(result.result.outputPreview.effectStarted, false);
  }
});
test('hardlinks, symlink targets and unsupported bytes cannot become an implicit replacement', async t => {
  const hard = fixture(t); linkSync(hard.file, path.join(hard.root, 'same-inode')); assert.equal((await hard.run()).result.outputPreview.outcome, 'conflict'); assert.equal(readFileSync(hard.file, 'utf8'), hard.before);
  const sym = fixture(t), alias = path.join(sym.root, 'alias'); symlinkSync(sym.file, alias); sym.target.reference.path = alias;
  assert.equal((await sym.run()).result.outputPreview.outcome, 'conflict'); assert.equal(readFileSync(sym.file, 'utf8'), sym.before);
  const invalid = fixture(t); writeFileSync(invalid.file, Buffer.from([0xff, 0x61])); invalid.target.base.contentVersion = hash(readFileSync(invalid.file));
  assert.equal((await invalid.run()).result.outputPreview.reason, 'RESOURCE_EDIT_UNSUPPORTED_TEXT'); assert.deepEqual(readFileSync(invalid.file), Buffer.from([0xff, 0x61]));
});
test('partial write and failed fsync remain uncertain, even when file bytes already equal the proposal', async t => {
  let writes = 0;
  const partial = fixture(t, { io: { write: (fd, buffer, offset, length, position) => { if (++writes > 1) throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); return writeSync(fd, buffer, offset, Math.min(2, length), position); } } });
  const result = await partial.run(); assert.equal(result.result.outputPreview.outcome, 'uncertain'); assert.equal(result.result.outputPreview.effectStarted, true); assert.equal(writes, 2); assert.notEqual(readFileSync(partial.file, 'utf8'), partial.before);
  const flush = fixture(t, { io: { sync: () => { throw Object.assign(Error('flush failed'), { code: 'EIO' }); } } });
  assert.equal((await flush.run()).result.outputPreview.outcome, 'uncertain'); assert.equal(readFileSync(flush.file, 'utf8'), flush.content);
});
test('abort while waiting for approval never writes; abort observed after actual write does not claim no effect', async t => {
  const waiting = fixture(t), stop = new AbortController(); waiting.context.signal = stop.signal;
  waiting.context.requestPermission = async () => { stop.abort(); return waiting.approval(); };
  assert.equal((await waiting.run()).result.outputPreview.outcome, 'cancelled'); assert.equal(readFileSync(waiting.file, 'utf8'), waiting.before);
  const lateStop = new AbortController(), actual = fixture(t, { io: { write: (...args) => { const n = writeSync(...args); lateStop.abort(); return n; } } }); actual.context.signal = lateStop.signal;
  const result = await actual.run(); assert.equal(result.result.outputPreview.outcome, 'applied'); assert.equal(result.result.outputPreview.observedVersion, hash(actual.content));
});
test('legacy writes share the same host file queue and cannot overwrite a conditional commit with a stale read cache', async t => {
  const f = fixture(t), approval = deferred(); f.context.requestPermission = async () => { await approval.promise; return f.approval(); };
  const pending = f.run(); await tick();
  const legacy = createLocalFileProvider({ workspaceRoot: f.root }), toolContext = { readFiles: new Map(), conversationId: 'conversation' };
  await legacy.executeCapability({ call: { toolCallId: 'legacy-read', capabilityId: 'local.file.read', arguments: { path: f.file } } }, { toolContext });
  let done = false; const oldWrite = legacy.executeCapability({ call: { toolCallId: 'legacy-write', capabilityId: 'local.file.write', arguments: { path: f.file, content: 'stale overwrite', allow_overwrite: true } } }, { toolContext }).then(value => { done = true; return value; });
  await tick(); assert.equal(done, false); approval.resolve(); assert.equal((await pending).result.outputPreview.outcome, 'applied');
  assert.equal((await oldWrite).result.status, 'denied'); assert.equal(readFileSync(f.file, 'utf8'), f.content);
});
test('large human drafts are not chunked through the model write_file limit and unchanged content reports no-change honestly', async t => {
  const f = fixture(t); f.call.arguments.content = '字'.repeat(200_000); f.call.arguments.proposedVersion = hash(f.call.arguments.content);
  const result = await f.run(); assert.equal(result.result.outputPreview.outcome, 'applied'); assert.equal(readFileSync(f.file, 'utf8'), f.call.arguments.content); assert.equal(result.result.outputPreview.diffPreviewTruncated, true);
  const same = fixture(t); same.call.arguments.content = same.before; same.call.arguments.proposedVersion = hash(same.before);
  const unchanged = await same.run(); assert.equal(unchanged.result.outputPreview.reason, 'no_change'); assert.equal(unchanged.result.outputPreview.effectStarted, false); assert.equal(unchanged.result.outputPreview.diffPreview, '');
});
