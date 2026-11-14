import test from 'node:test';
import assert from 'node:assert/strict';
import { digestRows,intersectMs,median } from './normalization-lab.mjs';
test('semantic digest binds every record and field without exposing its content',()=>{
  const rows=[{ref:'private-body',nested:{value:1}}],before=JSON.stringify(rows),digest=digestRows(rows);
  assert.equal(digest.length,64);assert.equal(digest.includes('private'),false);assert.equal(JSON.stringify(rows),before);
  assert.notEqual(digestRows([{...rows[0],nested:{value:2}}]),digest);
  assert.notEqual(digestRows([...rows,{ref:'new'}]),digest);
});
test('GC overlap is clipped to each read while medians retain even-sized groups',()=>{
  assert.equal(intersectMs(10,20,[{start:9,duration:3},{start:19,duration:5},{start:30,duration:1}]),3);
  assert.equal(median([4,1,3,2]),2.5);assert.equal(median([]),null);
});
