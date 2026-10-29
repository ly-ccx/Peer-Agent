import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalGitProvider } from './local-git-provider.mjs';
import { gitEvidencePreview } from './project-agent/git-evidence-preview.mjs';

const call = (root, id = 'git-read') => ({ toolCallId: id, capabilityId: 'local.git.query', arguments: { path: root, limit: 1 } });
function observation(root) {
  return { repositoryPath: root, gitDirectory: path.join(root, '.git'), commonDirectory: path.join(root, '.git'), operation: 'snapshot',
    startedAt: '2026-10-23T00:00:00Z', finishedAt: '2026-10-23T00:00:01Z', head: 'a'.repeat(40), branch: 'main', origin: [],
    unborn: false, consistent: true, atomic: false, commits: [],
    status: { clean: false, changed: 0, untracked: 3, entries: ['a', 'b', 'c'].map(name => ({ index: '?', worktree: '?', path: name })), truncated: false } };
}
test('bounded preview retains full immutable evidence and exact counts across repeated tool ids', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'peer-git-provider-')));
  try {
    const provider = createLocalGitProvider({ workspaceRoot: root, artifactBaseDir: path.join(root, 'artifacts'),
      query: async (args, context) => { await context.authorize(root); return observation(root); } });
    const first = await provider.executeCapability({ call: call(root) });
    const second = await provider.executeCapability({ call: call(root) });
    assert.equal(first.result.status, 'success'); assert.equal(first.grant.granted, true);
    assert.equal(first.result.outputPreview.status.untracked, 3); assert.equal(first.result.outputPreview.status.entries.length, 1);
    assert.equal(first.result.outputPreview.status.truncated, true);
    assert.equal(JSON.parse(readFileSync(first.result.outputPreview.artifactPath, 'utf8')).status.entries.length, 3);
    assert.notEqual(first.result.outputPreview.artifactPath, second.result.outputPreview.artifactPath);
    assert.equal(readdirSync(path.dirname(first.result.outputPreview.artifactPath)).length, 2);
    assert.equal(gitEvidencePreview(first).kind, 'observation');
    assert.equal(gitEvidencePreview({ ...first, grant: { ...first.grant, granted: false } }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('out-of-root permission and revoked authority fail without publishing a successful observation', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'peer-git-permission-')));
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'peer-git-outside-')));
  try {
    let valid = true, queries = 0;
    const provider = createLocalGitProvider({ workspaceRoot: root, artifactBaseDir: path.join(root, 'artifacts'), query: async (args, context) => {
      await context.authorize(outside); queries++; valid = false; context.checkAuthority(); return observation(outside);
    } });
    const denied = await provider.executeCapability({ call: call(outside) });
    assert.equal(queries, 0); assert.equal(denied.result.status, 'denied');
    assert.equal(denied.result.outputPreview.reason, 'git_read_permission_required');
    const revoked = await provider.executeCapability({ call: call(outside) }, { requestPermission: async () => ({ granted: true, validate: () => valid }) });
    assert.equal(revoked.result.status, 'denied'); assert.equal(revoked.grant.granted, false);
    assert.equal(gitEvidencePreview(revoked), null);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
