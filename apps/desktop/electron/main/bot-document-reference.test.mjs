import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBotDocumentResolver } from './bot-document-reference.mjs';

function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'peer-doc-preview-')));
  const root = path.join(dir, 'Bot'); const knowledge = path.join(dir, 'Peer-Knowledge');
  mkdirSync(root); mkdirSync(path.join(knowledge, 'knowledge'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# Bot');
  writeFileSync(path.join(knowledge, 'knowledge', 'ADR.md'), '# Decision');
  writeFileSync(path.join(dir, 'private.md'), 'outside');
  const options = { environment: {}, getWorkspace: id => id === 'bot' ? { ok: true, path: root } : { ok: false },
    readGitOrigin: async candidate => candidate === knowledge ? 'https://github.com/ly-ccx/Peer-Knowledge.git' : '' };
  return { dir, root, knowledge, options, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test('project and confirmed cross-repository paths resolve without changing the reference', async () => {
  const f = fixture();
  try {
    const resolve = createBotDocumentResolver(f.options);
    const reference = { workspaceId: 'bot', path: 'Peer-Knowledge/knowledge/ADR.md' };
    assert.deepEqual(await resolve(reference), { ok: true, root: f.knowledge, target: path.join(f.knowledge, 'knowledge/ADR.md') });
    assert.equal(reference.path, 'Peer-Knowledge/knowledge/ADR.md');
    assert.equal((await resolve({ workspaceId: 'bot', path: 'README.md' })).target, path.join(f.root, 'README.md'));
    assert.equal((await resolve({ ...reference, path: 'ADR.md', relativeTo: path.join(f.knowledge, 'knowledge/ADR.md') })).ok, true);
  } finally { f.dispose(); }
});

test('missing, permission denial, traversal, symlink escapes and unknown projects are explicit failures', async () => {
  const f = fixture();
  try {
    symlinkSync(path.join(f.dir, 'private.md'), path.join(f.root, 'escape.md'));
    const resolve = createBotDocumentResolver(f.options);
    for (const request of [{ path: '../private.md' }, { path: 'escape.md' }, { path: path.join(f.dir, 'private.md') },
      { path: 'Peer-Knowledge/../private.md' }, { path: 'README.md', relativeTo: path.join(f.dir, 'private.md') }]) {
      assert.equal((await resolve({ workspaceId: 'bot', ...request })).status, 'scope_denied');
    }
    assert.equal((await resolve({ workspaceId: 'bot', path: 'missing.md' })).status, 'not_found');
    assert.equal((await resolve({ workspaceId: 'unknown', path: 'README.md' })).status, 'workspace_unavailable');
    const denied = createBotDocumentResolver({ ...f.options, stat: target => {
      if (target.endsWith('README.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return statSync(target);
    } });
    assert.equal((await denied({ workspaceId: 'bot', path: 'README.md' })).status, 'permission_denied');
  } finally { f.dispose(); }
});

test('an unconfirmed knowledge identity and broken explicit configuration do not silently fall through', async () => {
  const f = fixture();
  try {
    const reference = { workspaceId: 'bot', path: 'Peer-Knowledge/knowledge/ADR.md' };
    const wrong = createBotDocumentResolver({ ...f.options, readGitOrigin: async () => 'https://github.com/someone/Other.git' });
    assert.equal((await wrong(reference)).status, 'workspace_unavailable');
    const configured = createBotDocumentResolver({ ...f.options, environment: { PEER_KNOWLEDGE_ROOT: path.join(f.dir, 'missing') } });
    assert.equal((await configured(reference)).status, 'workspace_unavailable');
  } finally { f.dispose(); }
});

test('duplicate registered repository names are reported as ambiguous rather than guessed', async () => {
  const f = fixture();
  try {
    const a = path.join(f.dir, 'a', 'Shared'); const b = path.join(f.dir, 'b', 'Shared');
    mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
    const resolve = createBotDocumentResolver({ ...f.options, getKnownRoots: () => [a, b] });
    assert.equal((await resolve({ workspaceId: 'bot', path: 'Shared/report.md' })).status, 'ambiguous_path');
  } finally { f.dispose(); }
});
