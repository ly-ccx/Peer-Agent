import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decryptChromeCookieValue,
  encryptChromeCookieValueForTests,
} from './chrome-decrypt.mjs';

test('encrypt/decrypt round-trip with v10 aes-128-cbc', () => {
  const password = 'unit-test-safe-storage';
  const plain = 'session-token-你好';
  const enc = encryptChromeCookieValueForTests(plain, password);
  assert.ok(enc.subarray(0, 3).equals(Buffer.from('v10')));
  const out = decryptChromeCookieValue(enc, { password });
  assert.equal(out, plain);
});

test('missing key fails closed', () => {
  const enc = encryptChromeCookieValueForTests('x', 'pw');
  assert.throws(() => decryptChromeCookieValue(enc, {}), /missing_decrypt_key/);
});
