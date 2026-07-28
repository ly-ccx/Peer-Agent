import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createPasswordVaultStore,
  normalizeOrigin,
} from './password-vault-store.mjs';

function makeFakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (buf) => {
      const text = Buffer.from(buf).toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('bad');
      return text.slice(4);
    },
  };
}

test('normalizeOrigin keeps scheme and host', () => {
  assert.equal(normalizeOrigin('https://Example.com/path'), 'https://example.com');
  assert.equal(normalizeOrigin('example.com'), 'https://example.com');
  assert.equal(normalizeOrigin('ftp://x'), '');
});

test('password vault upsert list reveal delete without leaking password in list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-pw-vault-'));
  const vaultFile = path.join(dir, 'browser-password-vault.json');
  const store = createPasswordVaultStore({
    vaultFile,
    safeStorage: makeFakeSafeStorage(),
  });

  const created = store.upsertEntry({
    origin: 'https://example.com',
    username: 'alice',
    password: 's3cret',
  });
  assert.ok(created.id);
  assert.equal(created.username, 'alice');
  assert.equal(created.origin, 'https://example.com');
  assert.equal(Object.prototype.hasOwnProperty.call(created, 'password'), false);

  const listed = store.listEntries();
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes('s3cret'), false);

  const revealed = store.revealPassword(created.id);
  assert.equal(revealed.ok, true);
  assert.equal(revealed.password, 's3cret');

  const updated = store.upsertEntry({
    origin: 'https://example.com',
    username: 'alice',
    password: 'new-pass',
  });
  assert.equal(updated.id, created.id);
  assert.equal(store.revealPassword(created.id).password, 'new-pass');

  const del = store.deleteEntry(created.id);
  assert.equal(del.ok, true);
  assert.equal(store.listEntries().length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('listForOrigin filters precisely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-pw-vault-'));
  const store = createPasswordVaultStore({
    vaultFile: path.join(dir, 'v.json'),
    safeStorage: makeFakeSafeStorage(),
  });
  store.upsertEntry({
    origin: 'https://a.example.com',
    username: 'u1',
    password: 'p1',
  });
  store.upsertEntry({
    origin: 'https://b.example.com',
    username: 'u2',
    password: 'p2',
  });
  assert.equal(store.listForOrigin('https://a.example.com').length, 1);
  assert.equal(store.listForOrigin('https://example.com').length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
