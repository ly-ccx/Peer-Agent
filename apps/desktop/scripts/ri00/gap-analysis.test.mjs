import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGap } from './gap-analysis.mjs';
test('gap attribution unions nested roots and clips CPU samples to uncovered intervals',()=>{
  const profile={startTime:0,nodes:[
    {id:1,callFrame:{functionName:'(root)',url:'',lineNumber:-1},children:[2]},
    {id:2,callFrame:{functionName:'resolveRoster',url:'/private/source/project-agent-host.mjs',lineNumber:477}},
  ],samples:[2,2,2,2],timeDeltas:[2000,2000,2000,4000]};
  const result=analyzeGap({records:[{id:1,entered:1,syncEnd:5},{id:2,entered:2,syncEnd:3},{id:3,entered:4,syncEnd:7}]},profile,{offsetMs:0},{from:0,to:10,gapMs:10});
  assert.equal(result.rootUnionMs,6);assert.deepEqual(result.uncoveredIntervals,[[0,1],[7,10]]);
  assert.equal(result.uncoveredSampledAttribution[0].sampledMs,4);
  assert.equal(result.uncoveredSampledAttribution[0].source,'project-agent-host.mjs:resolveRoster:478');
  assert.equal(JSON.stringify(result).includes('/private/'),false);
});
