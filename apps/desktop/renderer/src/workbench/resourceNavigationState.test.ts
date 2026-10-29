import assert from 'node:assert/strict';
import test from 'node:test';
import { auxiliaryNavigator, comparisonSourceLabel } from './resourceNavigationState.ts';

test('auxiliary navigation requires real measured room and a reading domain, never details/launcher overlay', () => {
  for (const width of [0, NaN, 719]) assert.equal(auxiliaryNavigator('files', 'documents', width), null);
  assert.equal(auxiliaryNavigator('files', 'documents', 720), 'files');
  assert.equal(auxiliaryNavigator('changes', 'browser', 1000), 'changes');
  for (const domain of ['details', 'launcher', 'files', 'changes']) assert.equal(auxiliaryNavigator('files', domain, 1000), null);
  assert.equal(auxiliaryNavigator(null, 'documents', 1000), null);
});
test('source aliases have distinct readable labels while exact repository paths stay visible', () => {
  assert.equal(comparisonSourceLabel('.', true), '当前项目');
  assert.equal(comparisonSourceLabel('Peer-Knowledge', true), '知识库');
  assert.equal(comparisonSourceLabel('/repos/task-worktree', false), '/repos/task-worktree');
});
