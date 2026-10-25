import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync, statSync, realpathSync } from 'node:fs';
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

test('a bare knowledge-relative path offers a confirmed location and opens it only after explicit selection', async () => {
  const f = fixture();
  try {
    const resolve = createBotDocumentResolver(f.options);
    const result = await resolve({ workspaceId: 'bot', path: 'knowledge/ADR.md' });
    assert.deepEqual(result, { ok: false, status: 'relative_base_required', error: 'relative_base_required', content: '',
      candidates: [{ path: path.join(f.knowledge, 'knowledge/ADR.md'), root: f.knowledge }] });
    const chosen = await resolve({ workspaceId: 'bot', path: result.candidates[0].path });
    assert.equal(chosen.ok, true); assert.equal(chosen.root, f.knowledge);
    assert.equal((await resolve({ workspaceId: 'bot', path: './knowledge/ADR.md' })).status, 'not_found');
    assert.equal((await resolve({ workspaceId: 'bot', path: 'knowledge/ADR.md', relativeTo: path.join(f.root, 'README.md') })).status, 'not_found');
    assert.equal((await resolve({ workspaceId: 'bot', path: 'Peer-Knowledge/missing.md' })).status, 'not_found');
  } finally { f.dispose(); }
});

test('project and nested document bases are retained when another repository contains the same file', async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.knowledge, 'README.md'), '# Knowledge');
    const resolve = createBotDocumentResolver(f.options);
    assert.equal((await resolve({ workspaceId: 'bot', path: 'README.md' })).target, path.join(f.root, 'README.md'));
    assert.equal((await resolve({ workspaceId: 'bot', path: '../README.md', relativeTo: path.join(f.knowledge, 'knowledge/ADR.md') })).target,
      path.join(f.knowledge, 'README.md'));
    assert.equal((await resolve({ workspaceId: 'bot', path: '../private.md' })).status, 'scope_denied');
  } finally { f.dispose(); }
});

test('multiple registered roots require a choice; candidate hints cannot bypass revalidation', async () => {
  const f = fixture();
  try {
    const a = path.join(f.dir, 'a', 'Shared'), b = path.join(f.dir, 'b', 'Shared');
    for (const base of [a, b]) { mkdirSync(base, { recursive: true }); writeFileSync(path.join(base, 'report.md'), '# Report'); }
    let roots = [a, b, a];
    const resolve = createBotDocumentResolver({ ...f.options, getKnownRoots: () => roots });
    const result = await resolve({ workspaceId: 'bot', path: 'report.md' });
    assert.equal(result.status, 'relative_base_required'); assert.equal(result.content, '');
    assert.deepEqual(result.candidates.map(row => row.path), [path.join(a, 'report.md'), path.join(b, 'report.md')]);
    unlinkSync(result.candidates[0].path); symlinkSync(path.join(f.dir, 'private.md'), result.candidates[0].path);
    assert.equal((await resolve({ workspaceId: 'bot', path: result.candidates[0].path })).status, 'scope_denied');
    roots = [];
    assert.equal((await resolve({ workspaceId: 'bot', path: result.candidates[1].path })).status, 'scope_denied');
    assert.equal((await resolve({ workspaceId: 'bot', path: 'report.md' })).status, 'not_found');
  } finally { f.dispose(); }
});

test('fallback discovery does not accept an unconfirmed companion, escaped file or unreadable candidate', async () => {
  const f = fixture();
  try {
    const reference = { workspaceId: 'bot', path: 'knowledge/ADR.md' };
    const wrong = createBotDocumentResolver({ ...f.options, readGitOrigin: async () => 'https://github.com/other/Knowledge.git' });
    assert.equal((await wrong(reference)).status, 'not_found');
    const broken = createBotDocumentResolver({ ...f.options, environment: { PEER_KNOWLEDGE_ROOT: path.join(f.dir, 'missing') } });
    assert.equal((await broken(reference)).status, 'workspace_unavailable');
    const denied = createBotDocumentResolver({ ...f.options, stat: target => {
      if (target === path.join(f.knowledge, 'knowledge/ADR.md')) throw Object.assign(Error('denied'), { code: 'EACCES' });
      return statSync(target);
    } });
    assert.equal((await denied(reference)).status, 'permission_denied');
    symlinkSync(path.join(f.dir, 'private.md'), path.join(f.knowledge, 'escape.md'));
    const resolve = createBotDocumentResolver(f.options);
    assert.equal((await resolve({ workspaceId: 'bot', path: 'escape.md' })).status, 'not_found');
  } finally { f.dispose(); }
});
