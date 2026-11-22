import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PEER_CORE_PROTOCOL_VERSION,
  createPeerCoreClient,
  isPeerCoreClassicEnabled,
  isPeerCoreDaemonEnabled,
  readPeerCoreDaemonDescriptor,
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

test('isPeerCoreClassicEnabled defaults on and respects explicit kill-switch env vars', () => {
  assert.equal(isPeerCoreClassicEnabled({}), true);
  assert.equal(isPeerCoreClassicEnabled({ PEER_CORE_CLASSIC: '0' }), false);
  assert.equal(isPeerCoreClassicEnabled({ PEER_CORE_CLASSIC: 'false' }), false);
  assert.equal(isPeerCoreClassicEnabled({ PEER_CORE_CLASSIC: 'off' }), false);
  assert.equal(isPeerCoreClassicEnabled({ PEER_CORE_ENGINE: 'ts' }), false);
  assert.equal(isPeerCoreClassicEnabled({ PEER_CORE_ENGINE: 'node' }), false);
  assert.equal(isPeerCoreClassicEnabled({ PEER_CORE_ENGINE: 'legacy' }), false);
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
    assert.deepEqual(caps.domains, [
      'core',
      'classic.chat',
      'classic.goal',
      'classic.conversations',
      'classic.usage',
      'classic.skills',
      'classic.mcp',
      'classic.llm',
      'project.memory',
      'project.objectives',
      'project.profile',
      'project.access',
      'project.bot',
    ]);
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

test('isPeerCoreDaemonEnabled defaults on and respects PEER_CORE_DAEMON kill-switch', () => {
  assert.equal(isPeerCoreDaemonEnabled({}), true);
  assert.equal(isPeerCoreDaemonEnabled({ PEER_CORE_DAEMON: '0' }), false);
  assert.equal(isPeerCoreDaemonEnabled({ PEER_CORE_DAEMON: 'false' }), false);
  assert.equal(isPeerCoreDaemonEnabled({ PEER_CORE_DAEMON: 'off' }), false);
  assert.equal(isPeerCoreDaemonEnabled({ PEER_CORE_DAEMON: '1' }), true);
  assert.equal(isPeerCoreDaemonEnabled({ PEER_CORE_DAEMON: 'true' }), true);
});

test('daemon transport shares one PID with a second client and peer bots --json, and shuts down cleanly via shutdownIfLast / core stop', async () => {
  const home = makeTempDataHome();
  const binaryPath = resolveTestBinary();

  const client1 = createPeerCoreClient({
    binaryPath,
    dataHome: home.dir,
    transport: 'daemon',
    clientInfo: { name: 'peer-desktop-1', version: '0.1.0-test' },
    logger: { info() {}, warn() {}, error() {} },
  });
  const client2 = createPeerCoreClient({
    binaryPath,
    dataHome: home.dir,
    transport: 'daemon',
    clientInfo: { name: 'peer-desktop-2', version: '0.1.0-test' },
    logger: { info() {}, warn() {}, error() {} },
  });

  let daemonEndpoint = null;
  try {
    const init1 = await client1.start();
    const st1 = client1.status();
    assert.equal(st1.state, 'ready');
    assert.equal(st1.transport, 'daemon');
    assert.equal(st1.ownedDaemon, true);
    assert.equal(st1.pid, init1.pid);
    assert.ok(st1.endpoint);
    daemonEndpoint = st1.endpoint;

    const descPath = path.join(home.dir, 'core-daemon.json');
    const descriptor = readPeerCoreDaemonDescriptor(home.dir);
    assert.ok(descriptor, 'expected core-daemon.json descriptor');
    assert.equal(descriptor.pid, st1.pid);
    if (process.platform !== 'win32') {
      assert.equal(statSync(descPath).mode & 0o777, 0o600);
      assert.equal(statSync(daemonEndpoint).mode & 0o777, 0o600);
    }

    await client2.start();
    const st2 = client2.status();
    assert.equal(st2.transport, 'daemon');
    assert.equal(st2.ownedDaemon, false);
    assert.equal(st2.pid, st1.pid);

    const status2 = await client2.request('core.daemon.status', {});
    assert.equal(status2.daemon, true);
    assert.equal(status2.connectedClients, 2);
    assert.equal(status2.initializedClients, 2);

    const botsStdout = execFileSync(binaryPath, ['bots', '--json'], {
      env: { ...process.env, PEER_AGENT_HOME: home.dir },
      encoding: 'utf8',
    });
    const parsedBots = JSON.parse(botsStdout.trim());
    assert.ok(Array.isArray(parsedBots));

    // client1 was owner (shutdownIfLast: true), but client2 is still connected -> daemon stays alive.
    await client1.dispose();
    const statusAfter1 = await client2.request('core.daemon.status', {});
    assert.equal(statusAfter1.connectedClients, 1);
    const pong2 = await client2.ping();
    assert.equal(pong2.ok, true);

    // client2 has ownedDaemon=false -> daemon stays running after client2 disconnects until `core stop`.
    await client2.dispose();
    assert.ok(existsSync(descPath), 'daemon descriptor should remain until core stop');

    execFileSync(binaryPath, ['core', 'stop'], {
      env: { ...process.env, PEER_AGENT_HOME: home.dir },
      encoding: 'utf8',
    });
    assert.equal(existsSync(descPath), false, 'core-daemon.json should be removed after core stop');
    if (process.platform !== 'win32') {
      assert.equal(existsSync(daemonEndpoint), false, 'unix socket should be removed after core stop');
    }

    // Also verify single-owner auto-shutdown via shutdownIfLast on dispose().
    const solo = createPeerCoreClient({
      binaryPath,
      dataHome: home.dir,
      transport: 'daemon',
      clientInfo: { name: 'peer-desktop-solo', version: '0.1.0-test' },
      logger: { info() {}, warn() {}, error() {} },
    });
    await solo.start();
    const soloEndpoint = solo.status().endpoint;
    assert.equal(solo.status().ownedDaemon, true);
    await solo.dispose();
    assert.equal(existsSync(descPath), false, 'single owner dispose must clean descriptor');
    if (process.platform !== 'win32') {
      assert.equal(existsSync(soloEndpoint), false, 'single owner dispose must clean unix socket');
    }
  } finally {
    await client1.dispose().catch(() => {});
    await client2.dispose().catch(() => {});
    try {
      execFileSync(binaryPath, ['core', 'stop'], {
        env: { ...process.env, PEER_AGENT_HOME: home.dir },
        stdio: 'ignore',
      });
    } catch {
      // Ignore cleanup errors if already stopped.
    }
    home.cleanup();
  }
});
