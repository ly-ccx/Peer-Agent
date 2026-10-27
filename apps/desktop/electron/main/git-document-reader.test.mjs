import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBotDocumentResolver } from './bot-document-reference.mjs';
import { createGitDocumentReader } from './git-document-reader.mjs';

const exec = promisify(execFile);
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'peer-git-document-')));
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git(['init', '--quiet']); mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'docs/guide.md'), '# Old version\n\n[Nested](nested.md)\n');
  writeFileSync(path.join(root, 'docs/nested.md'), '# Old nested\n');
  writeFileSync(path.join(root, 'docs/a[1].md'), 'literal brackets');
  writeFileSync(path.join(root, 'large.md'), 'x'.repeat(300));
  writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  writeFileSync(path.join(root, 'image.png'), Buffer.from([1, 2, 3, 4, 5]));
  git(['add', '.']);
  const commit = () => git(['-c', 'user.name=History Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'synthetic history']);
  commit();
  const first = git(['rev-parse', 'HEAD']);
  const link = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'docs/guide.md', encoding: 'utf8' }).trim();
  git(['update-index', '--add', '--cacheinfo', `120000,${link},link.md`]);
  git(['update-index', '--add', '--cacheinfo', `160000,${first},module`]); commit();
  const sha = git(['rev-parse', 'HEAD']);
  const index = readFileSync(path.join(root, '.git/index'));
  const calls = [];
  const resolveBotDocument = createBotDocumentResolver({ environment: {}, getWorkspace: id => id === 'bot' ? { ok: true, path: root } : { ok: false }, readGitOrigin: async () => '' });
  const options = { resolveBotDocument, executeGit: async (cwd, args, options) => { calls.push({ cwd, args, options }); return exec('git', ['-C', cwd, ...args], options); },
    maxTextFileBytes: 128, maxImageFileBytes: 256, imageMimeFromPath: file => file.endsWith('.png') ? 'image/png' : null };
  return { root, sha, git, calls, index, options, read: createGitDocumentReader(options),
    reference: (file = 'docs/guide.md') => ({ workspaceId: 'bot', path: file, revision: { kind: 'git', commit: sha } }),
    dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('deleted current files and their deleted relative origins remain exact historical blobs', async () => {
  const f = fixture();
  try {
    unlinkSync(path.join(f.root, 'docs/guide.md')); unlinkSync(path.join(f.root, 'docs/nested.md'));
    const old = await f.read(f.reference());
    assert.equal(old.ok, true); assert.ok(old.content.includes('# Old version'));
    const nested = await f.read({ ...f.reference('nested.md'), relativeTo: old.resolvedPath, revision: old.revision });
    assert.equal(nested.content, '# Old nested\n');
    writeFileSync(path.join(f.root, 'docs/nested.md'), '# Current content must not substitute\n');
    assert.equal((await f.read({ ...f.reference('nested.md'), relativeTo: old.resolvedPath, revision: old.revision })).content, '# Old nested\n');
    assert.deepEqual(readFileSync(path.join(f.root, '.git/index')), f.index);
    assert.equal(f.git(['rev-parse', 'HEAD']), f.sha);
    assert.ok(f.calls.every(call => call.args[0] === '--no-lazy-fetch' && call.args[1] === '--no-replace-objects'
      && ['rev-parse', '--literal-pathspecs', 'cat-file'].includes(call.args[2])));
    assert.ok(f.calls.every(call => call.options.timeout === 5000 && call.options.env.GIT_NO_LAZY_FETCH === '1' && call.options.env.GIT_NO_REPLACE_OBJECTS === '1'));
  } finally { f.dispose(); }
});

test('metadata never loads a blob; literal paths, exact versions and image bytes stay bound', async () => {
  const f = fixture();
  try {
    const meta = await f.read({ ...f.reference(), metadataOnly: true });
    assert.equal(meta.ok, true); assert.equal(meta.observation, undefined); assert.equal(meta.content, '');
    assert.equal(f.calls.some(call => call.args[2] === 'cat-file' && call.args[3] === 'blob'), false);
    assert.equal((await f.read(f.reference('docs/a[1].md'))).content, 'literal brackets');
    const read = await f.read(f.reference());
    assert.equal((await f.read({ ...f.reference(), expectedObservation: read.observation })).ok, true);
    const mismatch = await f.read({ ...f.reference(), expectedObservation: { ...read.observation, contentVersion: `sha256:${'f'.repeat(64)}` } });
    assert.equal(mismatch.status, 'version_changed'); assert.equal(mismatch.content, '');
    const image = await f.read(f.reference('image.png'), true);
    assert.equal(image.dataUrl, 'data:image/png;base64,AQIDBAU=');
    assert.equal((await f.read(f.reference('large.md'))).status, 'too_large');
    assert.equal((await f.read(f.reference('binary.dat'))).status, 'binary');
  } finally { f.dispose(); }
});

test('unknown commits, missing tree paths, special entries and source drift never fall back', async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.root, 'current-only.md'), 'not in the historical tree');
    for (const [name, status] of [['current-only.md', 'not_found'], ['link.md', 'unsupported_entry'], ['module', 'unsupported_entry'], ['docs', 'not_file']]) {
      const result = await f.read(f.reference(name)); assert.equal(result.status, status); assert.equal(result.content, '');
    }
    const unavailable = await f.read({ ...f.reference(), revision: { kind: 'git', commit: 'f'.repeat(40) } });
    assert.equal(unavailable.status, 'revision_unavailable');
    const other = await f.read({ ...f.reference(), revision: { ...f.reference().revision, repositoryId: `sha256:${'a'.repeat(64)}` } });
    assert.equal(other.status, 'source_changed'); assert.equal(other.content, '');
    assert.equal((await f.read({ ...f.reference(), workspaceId: 'other' })).ok, false);
    assert.equal((await f.read(f.reference('../private.md'))).status, 'scope_denied');
    const before = f.calls.length;
    for (const commit of ['HEAD', 'main', f.sha.slice(0, 8), `${f.sha}:docs/guide.md`, [f.sha]]) {
      assert.equal((await f.read({ ...f.reference(), revision: { kind: 'git', commit } })).status, 'invalid_ref');
    }
    assert.equal(f.calls.length, before);
  } finally { f.dispose(); }
});

test('old commits never follow a moving branch; failed buffers never become partial success', async () => {
  const f = fixture();
  try {
    const first = await f.read(f.reference());
    writeFileSync(path.join(f.root, 'docs/guide.md'), 'new commit body'); f.git(['add', 'docs/guide.md']);
    f.git(['-c', 'user.name=History Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'new synthetic commit']);
    assert.notEqual(f.git(['rev-parse', 'HEAD']), f.sha);
    assert.equal((await f.read(f.reference())).content, first.content);
    const broken = createGitDocumentReader({ ...f.options, executeGit: async (cwd, args, options) => {
      if (args[2] === 'cat-file' && args[3] === 'blob') throw Object.assign(Error('bounded read failed'), { code: 'ETIMEDOUT', stdout: Buffer.from('partial') });
      return f.options.executeGit(cwd, args, options);
    } });
    const result = await broken(f.reference()); assert.equal(result.ok, false); assert.equal(result.content, '');
  } finally { f.dispose(); }
});

test('unsupported safe Git flags fail closed instead of retrying without the network constraint', async () => {
  let calls = 0;
  const read = createGitDocumentReader({
    resolveBotDocument: async () => ({ ok: true, root: '/repo', target: '/repo/file.md' }), realpath: value => value,
    executeGit: async (_cwd, args) => { calls++; assert.equal(args[0], '--no-lazy-fetch'); throw Object.assign(Error('unsupported flag'), { code: 129 }); },
    maxTextFileBytes: 128, maxImageFileBytes: 256, imageMimeFromPath: () => null,
  });
  const result = await read({ workspaceId: 'bot', path: 'file.md', revision: { kind: 'git', commit: 'a'.repeat(40) } });
  assert.equal(result.status, 'version_unavailable'); assert.equal(result.content, ''); assert.equal(calls, 1);
});
