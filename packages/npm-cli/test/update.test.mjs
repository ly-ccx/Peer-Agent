import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  checkForCliUpdate,
  compareVersions,
  createCliUpdateController,
  resolveInstallSource,
  shouldCheckForUpdates,
  updateChannel,
} from '../../../apps/tui/src/cli-update.ts';

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function statePath() {
  const root = mkdtempSync(join(tmpdir(), 'peer-update-test-'));
  roots.push(root);
  return join(root, 'state.json');
}

function response(releases) {
  return new Response(JSON.stringify(releases), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CLI update versions', () => {
  it('orders stable and beta versions without crossing final releases', () => {
    assert.equal(compareVersions('0.0.2-beta.1', '0.0.2-beta.2'), -1);
    assert.equal(compareVersions('0.0.2-beta.9', '0.0.2'), -1);
    assert.equal(compareVersions('0.0.3', '0.0.2'), 1);
    assert.equal(updateChannel('0.0.2-beta.1'), 'beta');
    assert.equal(updateChannel('0.0.2'), 'stable');
  });
});

describe('CLI update environment', () => {
  it('checks only interactive terminals and supports explicit disable', () => {
    assert.equal(shouldCheckForUpdates({ env: {}, stdinIsTTY: true, stdoutIsTTY: true }), true);
    assert.equal(shouldCheckForUpdates({ env: { CI: '1' }, stdinIsTTY: true, stdoutIsTTY: true }), false);
    assert.equal(shouldCheckForUpdates({ env: { PEER_AGENT_NO_UPDATE_CHECK: '1' }, stdinIsTTY: true, stdoutIsTTY: true }), false);
    assert.equal(shouldCheckForUpdates({ env: {}, stdinIsTTY: false, stdoutIsTTY: true }), false);
  });

  it('uses source metadata passed by the npm shim', () => {
    assert.equal(resolveInstallSource({ PEER_AGENT_INSTALL_SOURCE: 'npm' }), 'npm');
    assert.equal(resolveInstallSource({ PEER_AGENT_INSTALL_SOURCE: 'pnpm' }), 'pnpm');
    assert.equal(resolveInstallSource({}), 'release');
  });
});

describe('CLI update confirmation', () => {
  const update = {
    currentVersion: '0.0.1', latestVersion: '0.0.2', source: 'npm', releaseUrl: 'https://example.test/release',
  };

  it('does not install until explicitly confirmed and supports dismissal', async () => {
    let installs = 0;
    const controller = createCliUpdateController({
      shouldCheck: () => true,
      checkImpl: async () => update,
      installImpl: async () => { installs += 1; },
    });
    await controller.check();
    assert.equal(controller.getStatus().phase, 'available');
    assert.equal(installs, 0);
    controller.dismiss();
    assert.equal(controller.getStatus().phase, 'dismissed');
    assert.equal(installs, 0);
  });

  it('records successful and failed confirmed installs', async () => {
    const successful = createCliUpdateController({
      shouldCheck: () => true, checkImpl: async () => update, installImpl: async () => {},
    });
    await successful.check();
    await successful.install();
    assert.equal(successful.getStatus().phase, 'installed');

    const failed = createCliUpdateController({
      shouldCheck: () => true, checkImpl: async () => update,
      installImpl: async () => { throw new Error('permission denied'); },
    });
    await failed.check();
    await failed.install();
    assert.equal(failed.getStatus().phase, 'failed');
    assert.match(failed.getStatus().error, /permission denied/);
  });
});

describe('CLI update discovery', () => {
  it('keeps beta and stable release channels separate', async () => {
    const releases = [
      { tag_name: 'v0.0.3-beta.2', prerelease: true, draft: false },
      { tag_name: 'v0.0.2', prerelease: false, draft: false },
    ];
    const beta = await checkForCliUpdate({
      currentVersion: '0.0.3-beta.1', force: true, statePath: statePath(),
      fetchImpl: async () => response(releases),
      env: { PEER_AGENT_INSTALL_SOURCE: 'pnpm' },
    });
    assert.equal(beta?.latestVersion, '0.0.3-beta.2');
    assert.equal(beta?.source, 'pnpm');

    const stable = await checkForCliUpdate({
      currentVersion: '0.0.1', force: true, statePath: statePath(),
      fetchImpl: async () => response(releases),
      env: {},
    });
    assert.equal(stable?.latestVersion, '0.0.2');
    assert.equal(stable?.source, 'release');
  });

  it('limits background checks using the persisted timestamp', async () => {
    let calls = 0;
    const path = statePath();
    const options = {
      currentVersion: '0.0.1', statePath: path, now: 10_000, intervalMs: 1_000,
      fetchImpl: async () => { calls += 1; return response([]); },
      env: {},
    };
    await checkForCliUpdate(options);
    await checkForCliUpdate({ ...options, now: 10_500 });
    assert.equal(calls, 1);
  });

  it('treats network failures as a non-blocking no-update result', async () => {
    const result = await checkForCliUpdate({
      currentVersion: '0.0.1', force: true, statePath: statePath(),
      fetchImpl: async () => { throw new Error('offline'); },
      env: {},
    });
    assert.equal(result, null);
  });
});
