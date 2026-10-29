import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationDecision } from './continuation-policy.mjs';

test('changing repair epochs and verification hashes alone cannot evade no-progress protection',()=>{
  let previous={};
  const rounds=(epoch,summary='unchanged result')=>[{toolCalls:[{name:'get_session',input:{sessionId:'s'},
    result:{status:'result_ready',summary,sourceRevision:`source-${epoch}`,observationRevision:`observed-${epoch}`,origin:{coordinationBinding:{executionEpoch:epoch}}}}]}];
  for(const epoch of ['one','two','three']) previous=continuationDecision({previous,rounds:rounds(epoch),yielded:true});
  assert.equal(previous.end,'no_progress');
  const changed=continuationDecision({previous,rounds:rounds('four','new concrete finding'),yielded:true});
  assert.equal(changed.end,'yielded');
  assert.equal(changed.repeats,0);
});
