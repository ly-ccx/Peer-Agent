// Development-only actual TS comparison; never a native CLI sidecar.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDecipheriv} from 'node:crypto';
import {buildQoderPrivateRequestBody,buildQoderPrivateHeaders} from '../../packages/runtime-node/src/provider-adapters/qoder-private-adapter.mjs';
const data=JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/qoder-legacy.json',import.meta.url),'utf8'));
assert.equal(data.schemaVersion,1);
for(const c of data.cases){
 assert.deepEqual(buildQoderPrivateRequestBody(c.builderInput),c.expected);
 assert.deepEqual(buildQoderPrivateHeaders({token:'SYNTHETIC',requestId:'request',sessionId:'session'}),c.headers);
}
for(const c of data.credentials){
 const key=Buffer.from(c.key);const decrypt=createDecipheriv('aes-128-cbc',key,key);
 assert.deepEqual(JSON.parse(Buffer.concat([decrypt.update(Buffer.from(c.encoded,'base64')),decrypt.final()]).toString()),c.profile);
}
console.log(`${data.cases.length} actual TS legacy body/header vectors and ${data.credentials.length} official encrypted credential carriers match.`);
