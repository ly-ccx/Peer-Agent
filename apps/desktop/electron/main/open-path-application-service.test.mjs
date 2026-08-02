import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOpenPathApplicationService } from './open-path-application-service.mjs';

async function withWorkspace(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'peer-open-path-'));
  try {
    const file = path.join(root, 'file.txt');
    const directory = path.join(root, 'folder');
    writeFileSync(file, 'content', 'utf8');
    mkdirSync(directory);
    return await run({ root, file, directory });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('open path rejects invalid, relative, missing, and out-of-workspace paths', async () => {
  await withWorkspace(async ({ root, file }) => {
    const service = createOpenPathApplicationService({
      openPath: async () => '',
      showItemInFolder: () => {},
    });

    assert.deepEqual(await service.open(), { ok: false, reason: 'invalid_path' });
    assert.deepEqual(await service.open({ absPath: 'relative.txt' }), {
      ok: false,
      reason: 'not_absolute',
    });
    assert.deepEqual(await service.open({ absPath: path.join(root, 'missing') }), {
      ok: false,
      reason: 'not_found',
    });
    assert.deepEqual(await service.open({ absPath: file, workspaceRoot: path.join(root, 'other') }), {
      ok: false,
      reason: 'out_of_workspace',
    });
  });
});

test('open path uses the default application and falls back to reveal', async () => {
  await withWorkspace(async ({ root, file, directory }) => {
    const calls = [];
    const service = createOpenPathApplicationService({
      async openPath(target) {
        calls.push(['open', target]);
        return target === file ? 'no default app' : '';
      },
      showItemInFolder(target) {
        calls.push(['show', target]);
      },
    });

    assert.deepEqual(await service.open({ absPath: file, workspaceRoot: root }), {
      ok: true,
      fallback: 'show-in-folder',
    });
    assert.deepEqual(await service.open({ absPath: directory, workspaceRoot: root }), { ok: true });
    assert.deepEqual(calls, [
      ['open', file],
      ['show', file],
      ['open', directory],
    ]);
  });
});

test('open path maps host exceptions to the legacy error payload', async () => {
  await withWorkspace(async ({ file }) => {
    const service = createOpenPathApplicationService({
      openPath: async () => {
        throw new Error('host failed');
      },
      showItemInFolder: () => {},
    });

    assert.deepEqual(await service.open({ absPath: file }), {
      ok: false,
      reason: 'error',
      message: 'host failed',
    });
  });
});
