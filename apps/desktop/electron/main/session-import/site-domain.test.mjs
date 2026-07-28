import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getRegistrableDomain,
  hostBelongsToRegistrableDomain,
  normalizeHostKey,
} from './site-domain.mjs';

test('normalizeHostKey strips leading dots', () => {
  assert.equal(normalizeHostKey('.Example.COM'), 'example.com');
});

test('getRegistrableDomain handles common and multi-part suffixes', () => {
  assert.equal(getRegistrableDomain('www.example.com'), 'example.com');
  assert.equal(getRegistrableDomain('.api.example.com'), 'example.com');
  assert.equal(getRegistrableDomain('foo.co.uk'), 'foo.co.uk');
  assert.equal(getRegistrableDomain('a.b.co.uk'), 'b.co.uk');
});

test('hostBelongsToRegistrableDomain does not match sibling suffix names', () => {
  assert.equal(hostBelongsToRegistrableDomain('www.example.com', 'example.com'), true);
  assert.equal(hostBelongsToRegistrableDomain('notexample.com', 'example.com'), false);
  assert.equal(hostBelongsToRegistrableDomain('example.com.evil.test', 'example.com'), false);
});
