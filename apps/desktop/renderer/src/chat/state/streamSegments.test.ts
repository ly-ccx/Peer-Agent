import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStreamSegment,
  segmentsSignature,
  mergeReattachedSegments,
  contentFromSegments,
  isEmptyAssistantPlaceholder,
  groupSegments,
  getTextContent,
  migrateToSegments,
  parseSerializedToolSegments,
} from './streamSegments.ts';
import type { ContentSegment } from './types.ts';

const txt = (content: string): ContentSegment => ({ type: 'text', content });
const think = (content: string): ContentSegment => ({ type: 'thinking', content });
const tool = (tool: string, over: Partial<Extract<ContentSegment, { type: 'tool-call' }>> = {}): ContentSegment => ({ type: 'tool-call', tool, args: {}, ...over });

describe('normalizeStreamSegment', () => {
  it('fills default args and keeps structured fields for tool-call', () => {
    const out = normalizeStreamSegment({ type: 'tool-call', tool: 't' } as ContentSegment);
    assert.deepEqual(out, { type: 'tool-call', tool: 't', args: {}, result: undefined, synthetic: undefined, toolCallId: undefined });
  });
  it('defaults content to empty string for text/thinking', () => {
    assert.deepEqual(normalizeStreamSegment({ type: 'text' } as ContentSegment), { type: 'text', content: '' });
  });
});

describe('segmentsSignature', () => {
  it('is equal for structurally equal segments', () => {
    assert.equal(segmentsSignature([txt('a'), tool('t')]), segmentsSignature([txt('a'), tool('t')]));
  });
  it('differs when content differs', () => {
    assert.notEqual(segmentsSignature([txt('a')]), segmentsSignature([txt('b')]));
  });
});

describe('mergeReattachedSegments', () => {
  it('returns live when persisted is empty', () => {
    assert.deepEqual(mergeReattachedSegments([], [txt('x')]), [txt('x')]);
  });
  it('returns persisted when live is empty', () => {
    assert.deepEqual(mergeReattachedSegments([txt('x')], []), [txt('x')]);
  });
  it('prefers live when it extends persisted as a prefix', () => {
    const out = mergeReattachedSegments([txt('a')], [txt('a'), txt('b')]);
    assert.deepEqual(out, [txt('a'), txt('b')]);
  });
  it('never drops persisted evidence on divergence (keeps history + live suffix)', () => {
    const out = mergeReattachedSegments([txt('a'), txt('b')], [txt('a'), txt('c')]);
    // common prefix = [a]; append live suffix after index 1 => [a, b, c]
    assert.deepEqual(out, [txt('a'), txt('b'), txt('c')]);
  });
});

describe('contentFromSegments', () => {
  it('joins text segments, ignores others', () => {
    assert.equal(contentFromSegments([txt('a'), tool('t'), txt('b')]), 'ab');
  });
  it('returns fallback when no text', () => {
    assert.equal(contentFromSegments([tool('t')], 'fb'), 'fb');
  });
});

describe('isEmptyAssistantPlaceholder', () => {
  it('true for empty assistant message', () => {
    assert.equal(isEmptyAssistantPlaceholder({ role: 'assistant', content: '   ', segments: [] }), true);
  });
  it('false when there is content or segments or non-assistant', () => {
    assert.equal(isEmptyAssistantPlaceholder({ role: 'assistant', content: 'hi', segments: [] }), false);
    assert.equal(isEmptyAssistantPlaceholder({ role: 'assistant', content: '', segments: [txt('x')] }), false);
    assert.equal(isEmptyAssistantPlaceholder({ role: 'user', content: '', segments: [] }), false);
  });
});

describe('groupSegments', () => {
  it('merges consecutive thinking and groups consecutive tool-calls', () => {
    const groups = groupSegments([think('a'), think('b'), tool('t1'), tool('t2'), txt('done')]);
    assert.equal(groups.length, 3);
    assert.deepEqual(groups[0], { type: 'thinking', content: 'ab' });
    assert.equal(groups[1].type, 'tool-call-group');
    assert.equal((groups[1] as { calls: unknown[] }).calls.length, 2);
    assert.deepEqual(groups[2], { type: 'text', content: 'done' });
  });
});

describe('getTextContent', () => {
  it('concatenates only text segments', () => {
    assert.equal(getTextContent([txt('a'), think('z'), txt('b')]), 'ab');
  });
});

describe('migrateToSegments', () => {
  it('returns undefined for empty inputs', () => {
    assert.equal(migrateToSegments('', undefined), undefined);
  });
  it('emits tool-call then text', () => {
    const out = migrateToSegments('body', [{ tool: 't', args: { a: 1 }, result: 'r' }]);
    assert.deepEqual(out, [
      { type: 'tool-call', tool: 't', args: { a: 1 }, result: 'r' },
      { type: 'text', content: 'body' },
    ]);
  });
});

describe('parseSerializedToolSegments', () => {
  it('returns undefined when no [Tool call:] marker', () => {
    assert.equal(parseSerializedToolSegments('plain text'), undefined);
  });
  it('parses a call with result and surrounding text', () => {
    const content = 'pre\n[Tool call: search {"q":"x"}]\n[Tool result]\nfound it';
    const out = parseSerializedToolSegments(content);
    assert.ok(out);
    const call = out!.find((s) => s.type === 'tool-call') as Extract<ContentSegment, { type: 'tool-call' }>;
    assert.equal(call.tool, 'search');
    assert.deepEqual(call.args, { q: 'x' });
    assert.equal(call.result, 'found it');
  });
  it('marks a call without result marker as synthetic', () => {
    const content = '[Tool call: run {"a":1}]\ntrailing';
    const out = parseSerializedToolSegments(content);
    const call = out!.find((s) => s.type === 'tool-call') as Extract<ContentSegment, { type: 'tool-call' }>;
    assert.equal(call.synthetic, true);
    assert.equal(call.result, undefined);
  });
  it('falls back to raw args when JSON is invalid', () => {
    const content = '[Tool call: run not-json]\n[Tool result]\nok';
    const out = parseSerializedToolSegments(content);
    const call = out!.find((s) => s.type === 'tool-call') as Extract<ContentSegment, { type: 'tool-call' }>;
    assert.deepEqual(call.args, { raw: 'not-json' });
  });
});
