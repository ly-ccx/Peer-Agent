import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PEER_CORE_PROTOCOL_VERSION,
  createPeerCoreClient,
  isPeerCoreClassicEnabled,
  resolvePeerCoreBinaryPath,
} from './peer-core-client.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function resolveTestBinary() {
  const filename = process.platform === 'win32' ? 'peer-native.exe' : 'peer-native';
  const candidates = [
    process.env.PEER_CORE_BINARY_PATH?.trim(),
    path.join(REPO_ROOT, 'target/debug', filename),
    path.join(REPO_ROOT, 'target/release', filename),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  assert.ok(found, `Expected built peer-native binary in one of: ${candidates.join(', ')}`);
  return found;
}

function makeTempDataHome() {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-core-client-test-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('isPeerCoreClassicEnabled respects default-off and explicit rollout env vars', () => {
  assert.equal(isPeerCoreClassicEnabled({}), false);
  assert.equal(isPeerCoreClassicEnabled({ PEER_CORE_CLASSIC: '0' }), false);
  assert.equal(isPeerCoreClassicEnabled({ PEER_CORE_CLASSIC: '1' }), true);
  assert.equal(isPeerCoreClassicEnabled({ PEER_CORE_ENGINE: 'rust' }), true);
  assert.throws(
    () => resolvePeerCoreBinaryPath({
      explicitPath: path.join(tmpdir(), 'nonexistent-peer-native-bin-12345'),
    }),
    (error) => error.code === 'peer_core_binary_not_found',
  );
});

test('connects to real peer core --stdio, registers external capabilities, and lists them', async () => {
  const home = makeTempDataHome();
  const binaryPath = resolveTestBinary();
  const client = createPeerCoreClient({
    binaryPath,
    dataHome: home.dir,
    clientInfo: { name: 'peer-desktop-test', version: '0.1.0-test' },
    externalCapabilities: [
      {
        alias: 'browser_open',
        capabilityId: 'local.web.control.open',
        manifest: { capabilityId: 'local.web.control.open', description: 'Open browser view' },
      },
      {
        alias: 'desktop_preview',
        capabilityId: 'local.preview.capture',
        manifest: { capabilityId: 'local.preview.capture', description: 'Capture preview' },
      },
    ],
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    const init = await client.start();
    assert.equal(init.protocolVersion, PEER_CORE_PROTOCOL_VERSION);
    assert.equal(init.server.name, 'peer-core');
    assert.deepEqual(
      init.capabilities.registeredExternalCapabilities,
      ['browser_open', 'desktop_preview'],
    );

    const status = client.status();
    assert.equal(status.state, 'ready');
    assert.ok(Number.isInteger(status.pid) && status.pid > 0);
    assert.equal(status.restartCount, 0);

    const caps = await client.listCapabilities();
    assert.deepEqual(caps.domains, ['core']);
    assert.equal(caps.externalCapabilities.length, 2);
    assert.equal(caps.externalCapabilities[1].capabilityId, 'local.preview.capture');
  } finally {
    await client.dispose();
    home.cleanup();
  }
});

test('supports bidirectional host.ping roundtrip via core.ping probeHost', async () => {
  const home = makeTempDataHome();
  const binaryPath = resolveTestBinary();
  let hostPingCalls = 0;

  const client = createPeerCoreClient({
    binaryPath,
    dataHome: home.dir,
    hostHandlers: {
      'host.ping': () => {
        hostPingCalls += 1;
        return { ok: true, surface: 'desktop-node-host', count: hostPingCalls };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    await client.start();
    const pong = await client.ping({ probeHost: true });
    assert.equal(pong.ok, true);
    assert.equal(hostPingCalls, 1);
    assert.deepEqual(pong.hostProbe, {
      ok: true,
      surface: 'desktop-node-host',
      count: 1,
    });
  } finally {
    await client.dispose();
    home.cleanup();
  }
});

test('recovers and respawns transparently after unexpected child termination', async () => {
  const home = makeTempDataHome();
  const binaryPath = resolveTestBinary();
  let exitEvents = [];
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const client = createPeerCoreClient({
    binaryPath,
    dataHome: home.dir,
    onUnexpectedExit: (info) => {
      exitEvents.push(info);
      resolveExit(info);
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    await client.start();
    const firstPid = client.status().pid;
    assert.ok(firstPid > 0);

    process.kill(firstPid, 'SIGKILL');
    await exitPromise;

    assert.equal(exitEvents.length, 1);
    assert.equal(client.status().state, 'exited');

    const pong = await client.ping();
    assert.equal(pong.ok, true);
    const recoveredStatus = client.status();
    assert.equal(recoveredStatus.state, 'ready');
    assert.equal(recoveredStatus.restartCount, 1);
    assert.notEqual(recoveredStatus.pid, firstPid);
  } finally {
    await client.dispose();
    home.cleanup();
  }
});

test('graceful dispose shuts down cleanly and rejects subsequent start or request', async () => {
  const home = makeTempDataHome();
  const binaryPath = resolveTestBinary();
  let unexpectedExitCalled = false;

  const client = createPeerCoreClient({
    binaryPath,
    dataHome: home.dir,
    onUnexpectedExit: () => {
      unexpectedExitCalled = true;
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    await client.start();
    assert.equal(await client.dispose(), true);
    assert.equal(await client.dispose(), false);
    assert.equal(unexpectedExitCalled, false);
    assert.equal(client.status().state, 'disposed');

    await assert.rejects(client.start(), /peer_core_disposed/);
    await assert.rejects(client.request('core.ping', {}), /not ready|disposed/);
  } finally {
    home.cleanup();
  }
});
