import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createHostRestarter } from './host-restart.mjs';

let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'host-restart-test-'));
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('createHostRestarter', () => {
  it('rejects when hostDir is missing', async () => {
    const restarter = createHostRestarter({ workspaceRoot: tmpRoot });
    await assert.rejects(() => restarter.restartHost({}), /host_restart_missing_host_dir/);
  });

  it('rejects when hostDir does not exist', async () => {
    // workspaceRoot has the restart script so we get past script resolution,
    // and fail specifically on a non-existent hostDir.
    mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });
    writeFileSync(path.join(tmpRoot, 'scripts', 'restart-host.mjs'), '// stub\n');
    const restarter = createHostRestarter({ workspaceRoot: tmpRoot });
    await assert.rejects(
      () => restarter.restartHost({ hostDir: path.join(tmpRoot, 'no-such-dir') }),
      /host_restart_host_dir_not_found/,
    );
  });

  it('rejects when restart-host.mjs script cannot be found', async () => {
    // hostDir exists, but workspaceRoot has no scripts/restart-host.mjs.
    const hostDir = path.join(tmpRoot, 'host');
    mkdirSync(hostDir, { recursive: true });
    const restarter = createHostRestarter({ workspaceRoot: tmpRoot });
    await assert.rejects(
      () => restarter.restartHost({ hostDir }),
      /host_restart_script_not_found/,
    );
  });

  it('spawns a detached launcher and returns its pid when inputs are valid', async () => {
    const hostDir = path.join(tmpRoot, 'host');
    mkdirSync(hostDir, { recursive: true });
    mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });
    // A no-op script that exits immediately, so the detached launcher does nothing harmful.
    writeFileSync(path.join(tmpRoot, 'scripts', 'restart-host.mjs'), 'process.exit(0);\n');

    const restarter = createHostRestarter({ workspaceRoot: tmpRoot });
    const result = await restarter.restartHost({ hostDir, port: 5999 });

    assert.equal(result.ok, true);
    assert.equal(result.hostDir, hostDir);
    assert.equal(result.port, 5999);
    assert.equal(typeof result.launcherPid, 'number');
    assert.ok(result.scriptPath.endsWith(path.join('scripts', 'restart-host.mjs')));
  });

  it('defaults port to 5173 when not provided', async () => {
    const hostDir = path.join(tmpRoot, 'host');
    mkdirSync(hostDir, { recursive: true });
    mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });
    writeFileSync(path.join(tmpRoot, 'scripts', 'restart-host.mjs'), 'process.exit(0);\n');

    const restarter = createHostRestarter({ workspaceRoot: tmpRoot });
    const result = await restarter.restartHost({ hostDir });
    assert.equal(result.port, 5173);
  });
});
