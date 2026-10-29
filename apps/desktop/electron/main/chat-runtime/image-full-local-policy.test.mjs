import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createApprovalStore, createLocalImageProvider } from '@peer-agent/runtime-node';
import { createChatPermissionGate } from './permission-gate.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const SHA256 = createHash('sha256').update(PNG).digest('hex');

async function fixture(t, accessLevel = 'full_local', decodeImage = () => ({ width: 1, height: 1 })) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'full-image-policy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const images = await Promise.all([0, 1, 2, 3].map(async i => {
    const image = join(root, `outside-${i}.png`); await writeFile(image, PNG); return image;
  }));
  const store = createApprovalStore({ rootDir: join(root, 'approvals') });
  const streams = new Map([
    ['bot', { approver: 'none', turnProfile: { role: 'project_agent', workspaceId: 'workspace' } }],
    ['worker', { approver: 'none', turnProfile: { role: 'work_session', workspaceId: 'workspace', sessionId: 'child', planId: 'plan' } }],
    ['verifier', { approver: 'none', turnProfile: { role: 'work_session', agentKind: 'verifier', workspaceId: 'workspace', sessionId: 'child', planId: 'plan' } }],
  ]);
  const events = [];
  const makeGate = () => createChatPermissionGate({ activeStreams: streams, accessLevel, approvalStore: store });
  let gate = makeGate();
  const provider = createLocalImageProvider({ workspaceRoot: workspace, decodeImage });
  const read = (role, image, id, policy) => provider.executeCapability({ call: {
    toolCallId: id, capabilityId: 'local.image.read', arguments: { path: image },
  } }, { toolContext: { accessLevel: 'full_local', turnRole: streams.get(role).turnProfile.role, permissionPolicy: policy },
    requestPermission: gate.createLocalCapabilityPermissionRequester({ streamId: role, toolCallId: id,
      conversationId: role === 'verifier' ? null : role, workspacePath: workspace, permissionPolicy: policy,
      webContents: { approver: 'none', send: (...event) => events.push(event) } }) });
  return { images, read, store, events, get gate() { return gate; }, restart() { gate = makeGate(); } };
}

test('Full authorizes every different outside image for Bot, worker, verifier and a restarted host without cards', async t => {
  const f = await fixture(t);
  for (const role of ['bot', 'worker', 'verifier']) {
    await t.test(role, async () => {
      for (const [i, image] of f.images.entries()) {
        const { grant, result } = await f.read(role, image, `${role}-${i}`);
        assert.equal(result.status, 'success');
        assert.equal(grant.granted, true);
        assert.match(grant.grantId, /^auto-/);
        assert.equal(grant.scope.path, image);
        assert.equal(result.modelContext.visualObservations[0].sha256, SHA256);
        assert.ok(result.evidence);
      }
    });
  }
  f.restart();
  assert.equal((await f.read('verifier', f.images[3], 'restored-verifier')).result.status, 'success');
  // A later normal call can read a changed image; Full is not a cached file identity grant.
  await writeFile(f.images[0], PNG);
  assert.equal((await f.read('bot', f.images[0], 'changed-image')).result.status, 'success');
  assert.equal(f.gate.listPendingPermissions().length, 0);
  assert.deepEqual(f.store.list(), []);
  assert.deepEqual(f.events, []);
});

test('Full image permission is revoked before pixels return when the access policy changes during decode', async t => {
  let f;
  f = await fixture(t, 'full_local', () => {
    f.gate.setAccessLevel('restricted_local');
    return { width: 1, height: 1 };
  });
  const { grant, result } = await f.read('bot', f.images[0], 'downgraded-during-read');
  assert.equal(grant.granted, false);
  assert.equal(result.status, 'denied');
  assert.equal(result.outputPreview.reason, 'image_permission_revoked');
  assert.equal(result.modelContext, undefined);
});

test('Full does not override explicit probe or automation policy', async t => {
  const f = await fixture(t);
  for (const policy of [{ kind: 'objective_probe' }, { kind: 'automation', preset: 'observe', allowedCapabilityIds: [] }]) {
    const { result } = await f.read('bot', f.images[0], policy.kind, policy);
    assert.equal(result.status, 'denied');
    assert.equal(result.modelContext, undefined);
  }
  assert.deepEqual(f.events, []);
});

test('non-Full modes still require an outside-image approval and cannot be impersonated by the role', async t => {
  for (const mode of ['ask_before_local', 'session_local', 'restricted_local']) {
    const f = await fixture(t, mode);
    for (const role of ['bot', 'worker', 'verifier']) {
      const { result } = await f.read(role, f.images[0], `${mode}-${role}`);
      assert.equal(result.status, 'denied');
      assert.equal(result.modelContext, undefined);
    }
  }
});
