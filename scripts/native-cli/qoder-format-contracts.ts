// Official SDK outputs are pinned fixtures, not a product SDK/VM dependency.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDecipheriv,hkdfSync} from 'node:crypto';
import {buildQoderRemoteChatAsk} from '../../packages/runtime-node/src/provider-adapters/qoder-private-adapter.mjs';
const data=JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/qoder-formats.json',import.meta.url),'utf8'));
assert.equal(data.schemaVersion,1);
assert.equal(data.provenance.authModuleSha256,'15dad38f7d9744dabfdc8a892ebad80d2c8157779f4e33882123ab3c954f04d3');
for(const c of data.credential){
 const key=Buffer.from(c.key);const decipher=createDecipheriv('aes-128-cbc',key,key);
 assert.equal(Buffer.concat([decipher.update(Buffer.from(c.encoded,'base64')),decipher.final()]).toString('utf8'),c.plain);
}
for(const c of data.cache){
 const bytes=Buffer.from(c.encoded,'base64');assert.equal(bytes.subarray(0,4).toString('hex'),'514d4301');
 if(c.error){assert.equal(bytes.length,32);continue;}
 const key=Buffer.from(hkdfSync('sha256',Buffer.from(c.uid),Buffer.from('qoder-model-cache-enc'),Buffer.from('model-cache-v1'),32));
 const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(4,16));decipher.setAuthTag(bytes.subarray(-16));
 assert.equal(Buffer.concat([decipher.update(bytes.subarray(16,-16)),decipher.final()]).toString('utf8'),c.expected);
}
const alphabet='_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const standard='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
for(const c of data.body){
 if(c.builderInput)assert.equal(JSON.stringify(buildQoderRemoteChatAsk(c.builderInput)),c.plain);
 const third=Math.floor(c.encoded.length/3);const reordered=c.encoded.slice(-third||c.encoded.length)+c.encoded.slice(third,c.encoded.length-third)+c.encoded.slice(0,third);
 const base64=[...reordered].map(ch=>ch==='$'?'=':standard[alphabet.indexOf(ch)]).join('');
 assert.equal(Buffer.from(base64,'base64').toString('utf8'),c.plain);
}
console.log(`${data.credential.length+data.cache.length+data.legacy.length+data.body.length} pinned official Qoder format vectors; Node crypto and 9 actual TS builder inputs match. Legacy carrier/error vectors are also checked by Rust.`);
