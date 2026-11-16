// Development reference only; the shipped CLI never executes this file.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,createDecipheriv} from 'node:crypto';
import {buildQoderRemoteChatAsk} from '../../packages/runtime-node/src/provider-adapters/qoder-private-adapter.mjs';
import {getQoderModelCatalog} from '../../packages/runtime-node/src/provider-adapters/qoder-model-catalog.mjs';
const data=JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/qoder-requests.json',import.meta.url),'utf8'));
assert.equal(data.schemaVersion,1);
assert.equal(data.provenance.authModuleSha256,'15dad38f7d9744dabfdc8a892ebad80d2c8157779f4e33882123ab3c954f04d3');
for(const c of data.requests)assert.deepEqual(buildQoderRemoteChatAsk(c.builderInput),c.expected);
for(const c of data.authentication){
 const authorization=c.headers.Authorization;const encodedEnvelope=authorization.split('.')[1];
 const envelope=JSON.parse(Buffer.from(encodedEnvelope,'base64').toString('utf8'));
 assert.equal(envelope.requestId,c.authRequestId);assert.notEqual(envelope.requestId,JSON.parse(c.body).request_id);
 const preimage=[encodedEnvelope,c.headers['Cosy-Key'],String(c.date),c.encoded,'/api/v2/service/pro/sse/agent_chat_generation'].join('\n');
 assert.equal(authorization,`Bearer COSY.${encodedEnvelope}.${createHash('md5').update(preimage).digest('hex')}`);
}
for(const c of data.fields){
 const key=Buffer.from('0707070707074707');const decipher=createDecipheriv('aes-128-cbc',key,key);
 assert.equal(Buffer.concat([decipher.update(Buffer.from(c.expected.encrypt_user_info,'base64')),decipher.final()]).toString(),c.plain);
 assert.deepEqual(JSON.parse(c.plain),c.identity);
}
const root=mkdtempSync(join(tmpdir(),'peer-qoder-catalog-'));
for(const [index,c] of data.catalogs.entries()){
 const configDir=join(root,String(index));mkdirSync(join(configDir,'.auth'),{recursive:true});writeFileSync(join(configDir,'.auth/models'),JSON.stringify(c.input));
 const keys=['id','label','source','format','contextWindow','maxOutputTokens','supportsVision','supportsReasoning','reasoningEffortLevels','reasoningDefaultEffort','modelOptions'];
 const actual=getQoderModelCatalog({env:{QODER_CONFIG_DIR:configDir},homeDir:configDir}).map(m=>Object.fromEntries(keys.filter(k=>m[k]!==undefined).map(k=>[k,m[k]])));
 assert.deepEqual(actual,c.expected);
}
rmSync(root,{recursive:true});
console.log(`${data.requests.length} actual TS Qoder request and ${data.catalogs.length} local catalog vectors, ${data.authentication.length} official SDK headers and ${data.fields.length} generated-field vectors match.`);
