import assert from 'node:assert/strict';
import { MODEL_OAUTH_HINT_FIELDS, modelConfigBinding } from '../../packages/runtime-node/src/model-config-file.mjs';
import { readFileSync } from 'node:fs';
import { resolveTuiModelConfig } from '../../apps/tui/src/model-config.ts';
import { encodeOpenAICompatibleRequest } from '../../packages/runtime-node/src/openai-compatible-provider.ts';
import { runPeerModels } from '../../apps/tui/src/cli-models.ts';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const channel={id:'group',channelId:'openai',provider:'openai',authMethod:'api_key',name:'Fixture Provider',apiKeyConfigured:true};
const row={id:'model-row',groupId:'group',model:'fixture-model',modelLabel:'Readable Model',enabled:true,isDefault:true};
const fixtures=[
 {name:'empty'},
 {name:'environment-defaults',env:{PEER_MODEL_API_KEY:'not-a-real-secret'}},
 {name:'environment-trimmed-model',env:{PEER_MODEL_API_KEY:'  not-a-real-secret ',PEER_MODEL_ID:'  chosen-model  ',PEER_MODEL_BASE_URL:' http://127.0.0.1:9/v1 '}},
 {name:'configured-v2',document:{version:2,channels:[channel],models:[row]}},
 {name:'environment-overrides-file',env:{PEER_MODEL_API_KEY:'not-a-real-secret',PEER_MODEL_ID:'explicit-env'},document:{version:2,channels:[channel],models:[row]}},
 {name:'blank-key-uses-file',env:{PEER_MODEL_API_KEY:'  '},document:{version:2,channels:[channel],models:[row]}},
 {name:'legacy-array',document:[{...channel,...row,groupId:'group'}]},
 {name:'legacy-envelope',document:{providers:[{...channel,...row,groupId:'group'}]}},
 {name:'missing-key-hint',document:{version:2,channels:[{...channel,apiKeyConfigured:false}],models:[row]}},
 {name:'disabled-model',document:{version:2,channels:[channel],models:[{...row,enabled:false}]}},
 {name:'multiple-models-and-whitespace-label',document:{version:2,channels:[channel],models:[row,{...row,id:'second',model:'another',modelLabel:'A\tB\nC',isDefault:false}]}},
 {name:'oauth-configured-hint',document:{version:2,channels:[{...channel,authMethod:'oauth_chatgpt',apiKeyConfigured:false,oauthConfigured:true}],models:[row]}},
];
const results=[];
for(const fixture of fixtures){
 const root=mkdtempSync(join(tmpdir(),'peer-model-list-probe-'));
 try{
  if('document' in fixture)writeFileSync(join(root,'llm-providers.json'),JSON.stringify(fixture.document));
  const stdout:string[]=[],stderr:string[]=[];
  const code=await runPeerModels({env:{PEER_AGENT_HOME:root,...fixture.env},stdout:l=>stdout.push(l),stderr:l=>stderr.push(l)});
  if([...stdout,...stderr].some(l=>l.includes('not-a-real-secret')))throw Error('fixture secret escaped');
  const resolved=resolveTuiModelConfig({PEER_AGENT_HOME:root,...fixture.env},{userDataPath:root});
  results.push({...fixture,expected:{exitCode:code,stdout,stderr,catalog:resolved.catalog}});
 }finally{rmSync(root,{recursive:true,force:true});}
}
const requests=['off','low','default','high'].map(reasoningEffort=>({reasoningEffort,expected:JSON.parse(encodeOpenAICompatibleRequest({model:'fixture-env',messages:[{role:'user',content:'hello'}],reasoningEffort}))}));
const file='packages/protocol/contracts/native-cli/model-catalog.json';
const output=JSON.stringify({version:1,cases:results,environmentRequests:requests},null,2)+'\n';
if(process.argv.includes('--write'))writeFileSync(file,output);else assert.equal(readFileSync(file,'utf8'),output,'regenerate actual TS model catalog contracts');
const bindingFile='packages/protocol/contracts/native-cli/model-binding.json';
const base={id:'account',authMethod:'oauth_chatgpt',enabled:true,customHeaders:{'X-Key':'first','x-key':'last'}};
const bindingCases=[base,{...base,oauthConfigured:true,oauthExpires:123,oauthAccountId:'hint'},
 {...base,authMethod:'oauth_google'},{...base,enabled:false},{...base,customHeaders:{'x-key':'last','X-Key':'first'}}]
 .map(value=>({value,expected:modelConfigBinding(value)}));
const binding=JSON.stringify({version:1,hintFields:MODEL_OAUTH_HINT_FIELDS,cases:bindingCases},null,2)+'\n';
if(process.argv.includes('--write'))writeFileSync(bindingFile,binding);else assert.equal(readFileSync(bindingFile,'utf8'),binding);
console.log(JSON.stringify({actualTsModelCases:results.length,actualTsEnvironmentRequests:requests.length}));
