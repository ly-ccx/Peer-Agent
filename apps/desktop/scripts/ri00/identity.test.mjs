import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contentIdentity, fixtureIdentity, resolveDestination } from './identity.mjs';

test('fixture identity binds content and relative names without disclosing them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ri00-identity-'));
  try {
    const file = path.join(root, 'private-task-identity.json');
    fs.writeFileSync(file, 'private contents');
    const first = contentIdentity(root);
    assert.equal(first.files, 1);
    assert.equal(JSON.stringify(first).includes('private'), false);
    assert.deepEqual(contentIdentity(root), first);
    fs.writeFileSync(file, 'changed contents');
    assert.notEqual(contentIdentity(root).sha256, first.sha256);
    fs.writeFileSync(file, 'private contents');
    fs.renameSync(file, path.join(root, 'renamed.json'));
    assert.notEqual(contentIdentity(root).sha256, first.sha256);
    fs.symlinkSync(path.join(root, 'renamed.json'), file);
    assert.throws(() => contentIdentity(root), /symlink_forbidden/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fixture inputs bind every canonical read store while separating diagnostic outputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ri00-scope-'));
  try {
    for (const folder of ['goal-plans', 'conversations', 'projects']) {
      fs.mkdirSync(path.join(root, folder)); fs.writeFileSync(path.join(root, folder, 'record'), 'original');
    }
    const first = fixtureIdentity(root);
    fs.mkdirSync(path.join(root, 'logs')); fs.writeFileSync(path.join(root, 'logs', 'diagnostic.log'), 'diagnostic output');
    assert.deepEqual(fixtureIdentity(root), first);
    fs.writeFileSync(path.join(root, 'projects', 'record'), 'changed');
    assert.notDeepEqual(fixtureIdentity(root), first);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a new destination resolves existing symlink parents before isolation checks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ri00-path-'));
  try {
    fs.mkdirSync(path.join(root, 'actual'));
    fs.symlinkSync(path.join(root, 'actual'), path.join(root, 'alias'));
    assert.equal(resolveDestination(path.join(root, 'alias', 'new', 'child')),
      path.join(fs.realpathSync(root), 'actual', 'new', 'child'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
