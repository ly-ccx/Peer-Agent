import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSseDataPayload } from './sse-line.mjs';

test('parses standard "data: " prefix with a single leading space', () => {
  assert.equal(parseSseDataPayload('data: {"a":1}'), '{"a":1}');
});

test('parses gateway "data:" prefix without a leading space (1688 gateway)', () => {
  assert.equal(parseSseDataPayload('data:{"a":1}'), '{"a":1}');
});

test('only strips a single leading space, preserving the rest', () => {
  assert.equal(parseSseDataPayload('data:  x'), ' x');
});

test('returns the [DONE] sentinel payload for both spacings', () => {
  assert.equal(parseSseDataPayload('data: [DONE]'), '[DONE]');
  assert.equal(parseSseDataPayload('data:[DONE]'), '[DONE]');
});

test('returns null for non-data lines', () => {
  assert.equal(parseSseDataPayload('event:content_block_delta'), null);
  assert.equal(parseSseDataPayload('event: message_start'), null);
  assert.equal(parseSseDataPayload(': comment'), null);
  assert.equal(parseSseDataPayload(''), null);
});

test('returns null for non-string input', () => {
  assert.equal(parseSseDataPayload(undefined), null);
  assert.equal(parseSseDataPayload(null), null);
});

test('returns empty string for a bare "data:" line', () => {
  assert.equal(parseSseDataPayload('data:'), '');
});
