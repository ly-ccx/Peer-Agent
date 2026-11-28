// Actual TS projector/encoder oracle; never part of native execution.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {projectConversationHistory} from '../../packages/runtime-core/dist/conversation-history-projector.js';
import {encodeOpenAIChatRequest,encodeAnthropicMessagesRequest,encodeGeminiGenerateContentRequest} from '../../packages/runtime-node/src/provider-encoders/index.mjs';
import {createChatGptResponsesProvider} from '../../packages/runtime-node/src/chatgpt-responses-provider.ts';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const urls=[['base64',png],['remote','https://images.invalid/a.png'],['percent','data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E'],['bad-base64','data:image/png;base64,%%%'],['file','file:///private/image.png'],['uppercase','DATA:image/png;base64,AA==']];
const cases=[];
for(const [name,url]of urls)for(const wire of ['openai-chat','openai-responses','anthropic-messages','gemini']){
 const raw=[{id:'input',role:'user',content:'Inspect saved material',attachments:[{kind:'text',name:'facts.txt',mimeType:'text/plain',size:4,text:'user data'},{kind:'image',dataUrl:url}]}];
 const projected=projectConversationHistory(raw);
 const input={model:'model',system:'system',messages:projected.messages,tools:[]};
 let expected;
 if(wire==='openai-chat')expected=encodeOpenAIChatRequest({...input,tools:undefined,messages:[{role:'system',content:'system'},...projected.messages]});
 else if(wire==='openai-responses'){
  const provider=createChatGptResponsesProvider({baseUrl:'https://model.invalid',tokens:{access:'SYNTHETIC',expires:Date.now()+3600000},fetch:async(_url,options)=>{expected=JSON.parse(options.body);return new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n',{headers:{'content-type':'text/event-stream'}});}});
  await provider.stream({...input,messages:[{role:'system',content:'system'},...projected.messages]});
 }
 else if(wire==='anthropic-messages')expected=encodeAnthropicMessagesRequest(input);
 else expected=encodeGeminiGenerateContentRequest({...input,messages:[{role:'system',content:'system'},...projected.messages]});
 const error=name==='bad-base64'?'model_image_invalid':name==='file'||(['remote','uppercase'].includes(name)&&['anthropic-messages','gemini'].includes(wire))||name==='percent'&&wire==='gemini'?'model_image_transport_unsupported':null;
 // Compare the actual JSON wire representation. Encoder objects may include
 // optional undefined fields, which HTTP JSON serialization omits.
 cases.push({wire,name,raw,projected,expected:JSON.parse(JSON.stringify(expected)),nativeError:error});
}
const fact={body:'🦀'.repeat(300000),escapes:'\n"\u0000'};
const encoded=JSON.stringify(fact);
const arrayEncoded=JSON.stringify([fact]);
const result={schemaVersion:1,provenance:'Actual TS canonical projector and wire encoders; native admission errors are explicit safety deltas.',requestBytes:536870912,factualJsonBytes:8388608,permissionJsonBytes:1048576,largeFact:{scalars:300000,bytes:Buffer.byteLength(encoded),sha256:createHash('sha256').update(encoded).digest('hex'),arrayBytes:Buffer.byteLength(arrayEncoded),arraySha256:createHash('sha256').update(arrayEncoded).digest('hex')},cases};
const file=new URL('../../packages/protocol/contracts/native-cli/attachment-images.json',import.meta.url);
if(process.argv.includes('--write'))writeFileSync(file,JSON.stringify(result,null,2)+'\n');else assert.deepEqual(result,JSON.parse(readFileSync(file,'utf8')));
console.log(`${cases.length} actual attachment wire vectors verified.`);
