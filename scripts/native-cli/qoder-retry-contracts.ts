// Development-only reference. No JS engine is used by the native sender.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classifyQoderStreamFailure,computeQoderQueueWaitMs} from '../../packages/runtime-node/src/provider-adapters/qoder-private-adapter.mjs';
const data=JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/qoder-retry.json',import.meta.url),'utf8'));
export function normalize(event){
 const c=classifyQoderStreamFailure(JSON.stringify(event),event);
 if(c.kind==='queued') return {kind:'queue',waitMs:c.waitTimeMs,cadenceMs:c.retryAfterMs,delays:[0,1,2,3,10].map(attempt=>computeQoderQueueWaitMs(c,{attempt}))};
 return c.kind==='transient'?{kind:c.reason==='duplicate'?'duplicate':'transient'}:null;
}
for(const c of data.cases) assert.deepEqual(normalize(c.event),c.expected);
console.log(`${data.cases.length} actual TS Qoder retry classifications and queue delay vectors match.`);
