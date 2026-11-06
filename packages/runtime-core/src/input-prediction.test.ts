import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import type { InputCandidate, InputPredictionRequest, InputPredictionResult } from '@peer-agent/protocol';
import { createInputPredictionController, type PredictionInput } from './input-prediction.ts';

const input: PredictionInput = { workspaceId: 'w', conversationId: 'c', surface: 'desktop_bot',
  text: '', selectionStart: 0, selectionEnd: 0, contextVersion: 'reply-1', active: true, eligible: true, composing: false };
function candidate(request: InputPredictionRequest): InputCandidate {
  return { ...request, candidateId: 'candidate', insertionText: '检查一下过渡。', contextToken: 'context', expiresAt: new Date(Date.now() + 60000).toISOString() };
}
function setup(overrides: Record<string, unknown> = {}) {
  const requests: InputPredictionRequest[] = [], edits: string[] = [], cancellations: unknown[] = [];
  let serial = 0;
  const controller = createInputPredictionController({ createId: () => `id-${++serial}`, debounceMs: { next_turn: 0, continuation: 0 },
    validationMs: 10, apply: text => edits.push(text),
    port: { request: async request => { requests.push(request); return { kind: 'candidate', candidate: candidate(request) }; },
      cancel: async ref => { cancellations.push(ref); }, validate: async () => ({ kind: 'valid' }), ...overrides },
  });
  return { controller, requests, edits, cancellations };
}

test('a visible candidate remains separate until explicit acceptance, then suppresses immediate regeneration', async t => {
  const f = setup(); t.after(f.controller.dispose);
  f.controller.update(input); await pause(10);
  assert.equal(f.controller.getSnapshot().status, 'visible'); assert.deepEqual(f.edits, []);
  assert.equal(await f.controller.accept(), true); assert.deepEqual(f.edits, ['检查一下过渡。']);
  assert.equal(await f.controller.accept(), false);
  f.controller.update({ ...input, text: f.edits[0]!, selectionStart: 7, selectionEnd: 7 }); await pause(10);
  assert.equal(f.requests.length, 1);
});

test('IME, selected text, mid-text caret, background and unavailable context never request inference', async t => {
  const f = setup(); t.after(f.controller.dispose);
  for (const patch of [{ composing: true }, { active: false }, { eligible: false }, { contextVersion: '' },
    { text: 'ab', selectionStart: 1, selectionEnd: 1 }, { text: 'ab', selectionStart: 0, selectionEnd: 2 }]) {
    f.controller.update({ ...input, ...patch }); await pause(3);
  }
  assert.equal(f.requests.length, 0);
});

test('late request results cannot revive a changed draft or a hidden input', async t => {
  let resolve!: (value: InputPredictionResult) => void;
  let original!: InputPredictionRequest;
  const f = setup({ request: (request: InputPredictionRequest) => { original = request; return new Promise<InputPredictionResult>(done => { resolve = done; }); } });
  t.after(f.controller.dispose);
  f.controller.update(input); await pause(5);
  f.controller.update({ ...input, text: '改了', selectionStart: 2, selectionEnd: 2, active: false });
  resolve({ kind: 'candidate', candidate: candidate(original) }); await pause(3);
  assert.equal(f.controller.getSnapshot().candidate, null); assert.ok(f.cancellations.length);
});

test('validation in flight performs local compare-and-set, never overwrites intervening edits', async t => {
  let resolve!: (value: { kind: 'valid' }) => void;
  const f = setup({ validate: () => new Promise(done => { resolve = done; }) }); t.after(f.controller.dispose);
  f.controller.update(input); await pause(5);
  const accepting = f.controller.accept();
  f.controller.update({ ...input, text: '用户的新输入', selectionStart: 7, selectionEnd: 7 });
  resolve({ kind: 'valid' }); assert.equal(await accepting, false); assert.deepEqual(f.edits, []);
});

test('validation timeout leaves the real draft intact', async t => {
  const f = setup({ validate: () => new Promise(() => {}) }); t.after(f.controller.dispose);
  f.controller.update(input); await pause(5);
  assert.equal(await f.controller.accept(), false); assert.deepEqual(f.edits, []);
});

test('Escape dismissal survives focus changes, and a new reply may suggest again', async t => {
  const f = setup(); t.after(f.controller.dispose);
  f.controller.update(input); await pause(5); f.controller.dismiss();
  f.controller.update({ ...input, active: false }); f.controller.update(input); await pause(5);
  assert.equal(f.requests.length, 1);
  f.controller.update({ ...input, contextVersion: 'reply-2' }); await pause(5);
  assert.equal(f.requests.length, 2);
});

test('continuation carries the exact prefix; stale owner, mode and invalid expiry are rejected', async t => {
  for (const patch of [{ composerInstanceId: 'other' }, { mode: 'next_turn' }, { expiresAt: 'invalid' }]) {
    const f = setup({ request: async (request: InputPredictionRequest) => ({ kind: 'candidate', candidate: { ...candidate(request), ...patch } }) });
    t.after(f.controller.dispose);
    f.controller.update({ ...input, text: '请', selectionStart: 1, selectionEnd: 1 }); await pause(5);
    assert.equal(f.controller.getSnapshot().candidate, null);
  }
});
