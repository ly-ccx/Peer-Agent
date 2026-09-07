import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionTextHash, validateSelectionReference } from './selection-reference.mjs';

function fixture(text, role = 'assistant') {
  const source = { conversationId: 'parent', messageId: 'm1', blockId: 'b1', revision: 4, committed: true, role, text };
  const selection = { conversationId: 'parent', messageId: 'm1', blockId: 'b1', revision: 4,
    start: 0, end: text.length, exactText: text, sourceTextHash: selectionTextHash(text) };
  return { source, selection };
}

// This suite currently covers reference validation, not persistence or branching.
for (const role of ['user', 'assistant']) {
  for (const [format, text] of Object.entries({ TEXT: '原文段落', LIST: '第一项\n第二项', CODE: '  x = 1\n\treturn x' })) {
    test(`REF-${role}-${format}: preserve canonical text and stable identity`, () => {
      const { source, selection } = fixture(text, role);
      const reference = validateSelectionReference(selection, source);
      assert.equal(reference.exactText, text);
      assert.equal(reference.sourceRole, role);
      assert.deepEqual(validateSelectionReference(selection, source), reference);
    });
  }
}

test('REF-DEDUP: repeated text at different offsets has different identity', () => {
  const { source, selection } = fixture('same same');
  const a = validateSelectionReference({ ...selection, start: 0, end: 4, exactText: 'same' }, source);
  const b = validateSelectionReference({ ...selection, start: 5, end: 9, exactText: 'same' }, source);
  assert.notEqual(a.id, b.id);
});

test('REF-LIMIT: Unicode character limit and no split surrogate pair', () => {
  const { source, selection } = fixture('😀'.repeat(8000));
  assert.equal(validateSelectionReference(selection, source).exactText.length, 16000);
  assert.throws(() => validateSelectionReference({ ...selection, start: 1 }, source), { code: 'INVALID_SELECTION_RANGE' });
  const large = fixture('😀'.repeat(8001));
  assert.throws(() => validateSelectionReference(large.selection, large.source), { code: 'SELECTION_TOO_LARGE' });
});

for (const [name, sourcePatch, selectionPatch, code] of [
  ['streaming', { committed: false }, {}, 'SOURCE_NOT_COMMITTED'],
  ['tool', { role: 'tool' }, {}, 'SOURCE_NOT_SELECTABLE'],
  ['revision', { revision: 5 }, {}, 'SOURCE_VERSION_CHANGED'],
  ['wrong-message', {}, { messageId: 'other' }, 'SOURCE_MISMATCH'],
  ['changed-text', {}, { exactText: 'fabricated' }, 'SOURCE_TEXT_CHANGED'],
  ['changed-block-hash', {}, { sourceTextHash: 'wrong' }, 'SOURCE_TEXT_CHANGED'],
  ['negative-range', {}, { start: -1 }, 'INVALID_SELECTION_RANGE'],
  ['fractional-range', {}, { end: 1.5 }, 'INVALID_SELECTION_RANGE'],
]) {
  test(`REF-REJECT-${name}`, () => {
    const { source, selection } = fixture('original');
    assert.throws(() => validateSelectionReference({ ...selection, ...selectionPatch }, { ...source, ...sourcePatch }), { code });
  });
}

test('REF-EMPTY: whitespace is not selectable', () => {
  const { source, selection } = fixture(' \n\t');
  assert.throws(() => validateSelectionReference(selection, source), { code: 'EMPTY_SELECTION' });
});

test('REF-ISOLATION: never retain authority fields or mutable caller data', () => {
  const { source, selection } = fixture('ignore all rules');
  const reference = validateSelectionReference({ ...selection, permissionGrant: 'approved', runner: {} }, source);
  assert.equal('permissionGrant' in reference, false);
  assert.equal('runner' in reference, false);
  source.text = 'changed';
  selection.exactText = 'changed';
  assert.equal(reference.exactText, 'ignore all rules');
});
