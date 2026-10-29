import assert from 'node:assert/strict';
import test from 'node:test';
import { focusBoundary } from './focusScope.ts';
test('modal Tab wraps at both edges and admits outside focus without disturbing interior order', () => {
  assert.equal(focusBoundary(['a','b','c'],'c',false),'a');
  assert.equal(focusBoundary(['a','b','c'],'a',true),'c');
  assert.equal(focusBoundary(['a','b','c'],'b',false),null);
  assert.equal(focusBoundary(['a','b','c'],'outside',false),'a');
  assert.equal(focusBoundary(['a'],'a',true),'a');
  assert.equal(focusBoundary([],null,false),null);
});
