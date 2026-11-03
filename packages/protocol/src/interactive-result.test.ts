import assert from 'node:assert/strict';
import test from 'node:test';
import { interactiveArtifactRef, normalizeInteractiveDraft, normalizeInteractiveInspect, normalizeInteractiveReference, normalizeInteractiveSelector, parseInteractiveArtifactRef } from './interactive-result.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
const reference = { owner, resultId: 'result-a', contentVersion: digest };
const draft = { publication: { kind: 'create' }, title: 'Result', textFallback: 'Model explanation', program: 'root = Col([Text("x")])',
  inputs: [{ bindingId: 'rows', source: { kind: 'model-data', value: [{ id: 'a', cost: 1 }] } }] };

test('interactive references are fixed and reject paths, owner injection and unknown fields', () => {
  assert.deepEqual(normalizeInteractiveReference(reference), reference);
  for (const raw of [{ ...reference, contentVersion: 'latest' }, { ...reference, resultId: '../x' }, { ...reference, path: '/private' },
    { ...reference, owner: { ...owner, permission: true } }]) assert.equal(normalizeInteractiveReference(raw), undefined);
  assert.deepEqual(parseInteractiveArtifactRef(interactiveArtifactRef(reference)), reference);
  assert.equal(parseInteractiveArtifactRef(interactiveArtifactRef(reference) + '/extra'), undefined);
  assert.equal(parseInteractiveArtifactRef('file:///private/result'), undefined);
});

test('publication create and revision have different exact contracts', () => {
  assert.deepEqual(normalizeInteractiveDraft(draft), draft);
  const revise = { ...draft, publication: { kind: 'revise', base: reference } };
  assert.deepEqual(normalizeInteractiveDraft(revise), revise);
  assert.equal(normalizeInteractiveDraft({ ...draft, publication: { kind: 'create', resultId: 'chosen' } }), undefined);
  assert.equal(normalizeInteractiveDraft({ ...draft, publication: { kind: 'revise' } }), undefined);
  for (const field of ['grant', 'workspaceId', 'owner', 'capabilityId', 'directory', 'specHash']) assert.equal(normalizeInteractiveDraft({ ...draft, [field]: 'injected' }), undefined);
});

test('canonical material references require specific immutable source identity', () => {
  for (const source of [
    { kind: 'tool-result', conversationId: 'worker', toolCallId: 'call-a', expectedContentVersion: digest },
    { kind: 'user-material', messageId: 'input-a', attachmentId: 'attachment-a', expectedContentVersion: digest },
  ]) {
    const raw = { ...draft, inputs: [{ bindingId: 'data', source }] };
    assert.deepEqual(normalizeInteractiveDraft(raw), raw);
    assert.equal(normalizeInteractiveDraft({ ...draft, inputs: [{ bindingId: 'data', source: { ...source, path: '/private' } }] }), undefined);
    assert.equal(normalizeInteractiveDraft({ ...draft, inputs: [{ bindingId: 'data', source: { ...source, expectedContentVersion: undefined } }] }), undefined);
  }
  assert.equal(normalizeInteractiveDraft({ ...draft, inputs: [...draft.inputs, ...draft.inputs] }), undefined);
});

test('model data cannot contain nonfinite/executable/prototype data or exceed bounds', () => {
  for (const value of [Infinity, () => 1, new Date(), Array.from({ length: 501 }, () => 0), JSON.parse('{"__proto__":1}')]) {
    assert.equal(normalizeInteractiveDraft({ ...draft, inputs: [{ bindingId: 'x', source: { kind: 'model-data', value } }] }), undefined);
  }
  let called = false;
  const value = Object.defineProperty({}, 'x', { enumerable: true, get() { called = true; return 'secret'; } });
  assert.equal(normalizeInteractiveDraft({ ...draft, inputs: [{ bindingId: 'x', source: { kind: 'model-data', value } }] }), undefined);
  assert.equal(called, false);
});

test('selectors are bounded own-field/range selections with no JSONPath or evaluation', () => {
  assert.deepEqual(normalizeInteractiveSelector({ path: ['data'], fields: ['cost'], start: 0, limit: 100 }), { path: ['data'], fields: ['cost'], start: 0, limit: 100 });
  for (const value of [{ path: ['constructor'] }, { path: ['$.data'] }, { fields: ['a', 'a'] }, { limit: 501 }, { start: -1 }, { script: 'read()' }]) {
    assert.equal(normalizeInteractiveSelector(value), undefined);
  }
});

test('inspection has distinct operation and content targets and bounded projections', () => {
  const content = { target: { kind: 'result', reference }, view: 'data', bindingId: 'rows', selector: { fields: ['cost'], limit: 2 } };
  assert.deepEqual(normalizeInteractiveInspect(content), content);
  const operation = { target: { kind: 'publication', reference: { owner, conversationId: 'worker', toolCallId: 'call-a' } }, view: 'metadata' };
  assert.deepEqual(normalizeInteractiveInspect(operation), operation);
  assert.equal(normalizeInteractiveInspect({ ...operation, view: 'data', bindingId: 'rows' }), undefined);
  for (const extra of [{ path: '/private' }, { limit: 4001 }, { followupId: 'x' }, { bindingId: 'rows' }]) {
    assert.equal(normalizeInteractiveInspect({ target: { kind: 'result', reference }, view: 'text', ...extra }), undefined);
  }
});
