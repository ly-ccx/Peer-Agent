import assert from 'node:assert/strict';
import test from 'node:test';
import { textareaText, textInputEdit } from './textInputEdit.ts';
test('unchanged input preserves CRLF/lone CR and Unicode source bytes', () => {
  for (const text of ['a\r\nb\r\n', 'a\rb\r', '中文😀\r\nnext\nlast\r']) assert.equal(textInputEdit(text, textareaText(text)), text);
});
test('actual text edits preserve unrelated mixed newline endings and use nearby style for inserted lines', () => {
  assert.equal(textInputEdit('first\r\nsecond\r\n', 'first\nchanged\n'), 'first\r\nchanged\r\n');
  assert.equal(textInputEdit('a\r\nb\nc\r', 'a\nb\nNEW\nc\n'), 'a\r\nb\nNEW\nc\r');
  assert.equal(textInputEdit('a\r\nb\r\n', 'a\nb\nc\n'), 'a\r\nb\r\nc\r\n');
  assert.equal(textInputEdit('', '中文😀\nnext'), '中文😀\nnext');
});
