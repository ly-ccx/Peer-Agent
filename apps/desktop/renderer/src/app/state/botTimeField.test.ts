import assert from 'node:assert/strict';
import test from 'node:test';
import { splitBotTime, updateBotTime } from './botTimeField.ts';
test('custom time field keeps HH:mm, midnight and untouched components without admitting impossible times', () => {
  assert.deepEqual(splitBotTime('23:59'), ['23', '59']);
  assert.deepEqual(splitBotTime('24:59'), ['00', '00']);
  assert.equal(updateBotTime('22:15','hour','00'),'00:15');
  assert.equal(updateBotTime('22:15','minute','59'),'22:59');
  assert.equal(updateBotTime('22:15','hour','24'),'22:15');
  assert.equal(updateBotTime('22:15','minute','60'),'22:15');
});
