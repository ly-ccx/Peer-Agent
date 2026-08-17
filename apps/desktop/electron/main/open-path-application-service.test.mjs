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

test('open path resolves the parent folder for a file and for a directory', async () => {
  await withWorkspace(async ({ root, file, directory }) => {
    const calls = [];
    const service = createOpenPathApplicationService({
      openPath: async () => '',
      showItemInFolder(target) {
        calls.push(['show', target]);
      },
    });

    // 文件 -> 所在目录；目录 -> 自身。两者都报 kind='directory'。
    assert.deepEqual(await service.open({ absPath: file, target: 'parent', mode: 'reveal' }), {
      ok: true,
      kind: 'directory',
      mode: 'reveal',
      path: root,
    });
    assert.deepEqual(await service.open({ absPath: directory, target: 'parent', mode: 'reveal' }), {
      ok: true,
      kind: 'directory',
      mode: 'reveal',
      path: directory,
    });
    assert.deepEqual(calls, [
      ['show', root],
      ['show', directory],
    ]);
  });
});

test('open path reveals the item itself without touching the default app', async () => {
  await withWorkspace(async ({ file }) => {
    const calls = [];
    const service = createOpenPathApplicationService({
      openPath: async (target) => {
        calls.push(['open', target]);
        return '';
      },
      showItemInFolder(target) {
        calls.push(['show', target]);
      },
    });

    assert.deepEqual(await service.open({ absPath: file, mode: 'reveal' }), {
      ok: true,
      kind: 'file',
      mode: 'reveal',
      path: file,
    });
    assert.deepEqual(calls, [['show', file]]);
  });
});

test('open path delegates to an editor for files and for folders', async () => {
  await withWorkspace(async ({ root, file, directory }) => {
    const calls = [];
    const service = createOpenPathApplicationService({
      openPath: async () => '',
      showItemInFolder: () => {},
      async launchEditor({ editorId, absPath }) {
        calls.push([editorId, absPath]);
        return { ok: true, editorId };
      },
    });

    assert.deepEqual(await service.open({ absPath: file, mode: 'editor', editorId: 'vscode' }), {
      ok: true,
      kind: 'file',
      mode: 'editor',
      editorId: 'vscode',
      path: file,
    });
    assert.deepEqual(
      await service.open({ absPath: file, mode: 'editor', editorId: 'zed', target: 'parent' }),
      { ok: true, kind: 'directory', mode: 'editor', editorId: 'zed', path: root },
    );
    assert.deepEqual(
      await service.open({ absPath: directory, mode: 'editor', editorId: 'zed' }),
      { ok: true, kind: 'directory', mode: 'editor', editorId: 'zed', path: directory },
    );
    assert.deepEqual(calls, [
      ['vscode', file],
      ['zed', root],
      ['zed', directory],
    ]);
  });
});

test('open path surfaces editor launch problems instead of silently revealing', async () => {
  await withWorkspace(async ({ file }) => {
    const revealed = [];
    const withoutEditor = createOpenPathApplicationService({
      openPath: async () => '',
      showItemInFolder: (target) => revealed.push(target),
    });
    assert.deepEqual(await withoutEditor.open({ absPath: file, mode: 'editor' }), {
      ok: false,
      reason: 'editor_unavailable',
    });

    const failing = createOpenPathApplicationService({
      openPath: async () => '',
      showItemInFolder: (target) => revealed.push(target),
      launchEditor: async () => ({ ok: false, reason: 'editor_not_found' }),
    });
    assert.deepEqual(
      await failing.open({ absPath: file, mode: 'editor', editorId: 'ghost' }),
      { ok: false, reason: 'editor_not_found', message: '' },
    );

    // 编辑器打开失败不应偷偷退化成「在 Finder 中显示」。
    assert.deepEqual(revealed, []);
  });
});

test('open path rejects unknown target and mode values', async () => {
  await withWorkspace(async ({ file }) => {
    const service = createOpenPathApplicationService({
      openPath: async () => '',
      showItemInFolder: () => {},
    });

    assert.deepEqual(await service.open({ absPath: file, target: 'sibling' }), {
      ok: false,
      reason: 'invalid_target',
    });
    assert.deepEqual(await service.open({ absPath: file, mode: 'teleport' }), {
      ok: false,
      reason: 'invalid_mode',
    });
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
