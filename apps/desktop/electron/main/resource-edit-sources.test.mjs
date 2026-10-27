import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createResourceEditSources } from './resource-edit-sources.mjs';
const hash = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const observed = { resourceId: hash('identity'), contentVersion: hash('exact\r\n🙂') };
const source = { kind: 'document', reference: { workspaceId: 'bot', path: 'docs/a.md' }, observed };
function fixture() {
  const main = {}, native = {}, calls = [], roles = new Map([[main, 'main'], [native, 'resource']]); let owner = 'main', current = true;
  let read = { ok: true, content: 'exact\r\n🙂', observation: observed, resolvedPath: '/fixture/docs/a.md', resolvedFrom: '/fixture' };
  let metadata = { ok: true, metadataOnly: true, identity: { resourceId: observed.resourceId }, resolvedPath: '/fixture/docs/a.md', resolvedFrom: '/fixture' };
  const host = createResourceEditSources({ getRole: sender => roles.get(sender), getOwner: () => ({ conversationId: owner }),
    fileAccess: { readFile: async request => { calls.push(request); return request.documentReference.metadataOnly ? metadata : read; } },
    resourceWindows: { isEditingSourceCurrent: () => current, readEditingSource: async () => ({ ...read, owner: { workspaceId: 'bot', conversationId: 'main' }, reference: { workspaceId: 'bot', path: '/fixture/docs/a.md' } }) } });
  return { host, main, native, calls, roles, setRead: value => { read = value; }, setMetadata: value => { metadata = value; }, replaceOwner: () => { owner = 'other'; }, expire: () => { current = false; } };
}
test('canonical host path, exact raw text and actual Bot owner are bound; client relative path never becomes an execution root', async () => {
  const f = fixture(), result = await f.host.read(f.main, source);
  assert.equal(result.ok, true); assert.equal(result.target.reference.path, '/fixture/docs/a.md'); assert.equal(result.target.recipient.conversationId, 'main');
  assert.deepEqual(f.calls[0].documentReference.expectedObservation, observed); assert.equal(result.content, 'exact\r\n🙂');
  assert.equal('relativeTo' in result.target.reference, false);
  assert.equal((await f.host.read(f.native, source)).ok, false);
});
test('changed versions, replacement bytes, binary/oversize and lost sources stay explicit instead of switching to a new base', async () => {
  const f = fixture(); f.setRead({ ok: false, status: 'version_changed' }); assert.equal((await f.host.read(f.main, source)).code, 'RESOURCE_EDIT_VERSION_CHANGED');
  f.setRead({ ok: true, content: 'replacement', observation: observed, resolvedPath: '/fixture/docs/a.md' }); assert.equal((await f.host.read(f.main, source)).code, 'RESOURCE_EDIT_UNSUPPORTED_TEXT');
  f.setRead({ ok: false, status: 'permission_denied' }); assert.equal((await f.host.read(f.main, source)).code, 'RESOURCE_EDIT_SCOPE_DENIED');
  f.setRead({ ok: false, status: 'not_found' }); assert.equal((await f.host.read(f.main, source)).code, 'RESOURCE_EDIT_FILE_NOT_FOUND');
});
test('retained bytes still require present source scope and actual native lease, without fetching current full text or granting access', async () => {
  const f = fixture(), read = await f.host.read(f.main, source), nativeSource = { kind: 'native', identity: { viewId: 'v', windowId: 'w', generation: 1 }, observed };
  assert.equal(await f.host.canReadRetained(f.main, read.target, null), true); assert.equal(f.calls.at(-1).documentReference.metadataOnly, true);
  assert.equal(await f.host.canReadRetained({}, read.target, null), false);
  assert.equal(await f.host.canReadRetained(f.native, read.target, nativeSource), true); f.expire();
  assert.equal(await f.host.canReadRetained(f.native, read.target, nativeSource), false);
  f.replaceOwner(); assert.equal(await f.host.canReadRetained(f.main, read.target, null), false);
});
test('submission target comes only from the current Reader root/path/identity; current observation drops the old content condition alone', async () => {
  const f = fixture(), initial = await f.host.read(f.main, source), target = initial.target;
  const found = await f.host.resolveSubmissionTarget(f.main, source, target);
  assert.equal(found.ok, true); assert.equal(found.root, '/fixture'); assert.equal(found.path, '/fixture/docs/a.md'); assert.equal(found.validate(), true);
  f.setRead({ ok: true, content: 'new', observation: { ...observed, contentVersion: hash('new') }, resolvedPath: found.path, resolvedFrom: found.root });
  const current = await f.host.readSubmissionCurrent(f.main, source, target); assert.equal(current.contentVersion, hash('new'));
  assert.deepEqual(f.calls.at(-1).documentReference.expectedObservation, { resourceId: observed.resourceId });
  f.setMetadata({ ok: true, metadataOnly: true, identity: { resourceId: observed.resourceId }, resolvedPath: '/other/a.md', resolvedFrom: '/other' });
  assert.equal((await f.host.resolveSubmissionTarget(f.main, source, target)).ok, false);
  f.replaceOwner(); assert.equal(found.validate(), false);
});
