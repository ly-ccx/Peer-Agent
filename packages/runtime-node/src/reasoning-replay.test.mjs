import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeOpenAIChatRequest } from './provider-encoders/request-encoder.mjs';
const tool = id => ({ id, type:'function', function:{name:'read_file',arguments:'{}'} });
test('DeepSeek retains native reasoning exactly and admits missing historical pairs as data', () => {
 const messages = [{role:'user',content:'continue'}, {role:'assistant',content:'old',tool_calls:[tool('old')]},
  {role:'tool',tool_call_id:'old',content:'old factual result'},
  {role:'assistant',content:null,reasoning_content:'native\nreasoning',tool_calls:[tool('current')]},
  {role:'tool',tool_call_id:'current',content:'new result'}, {role:'assistant',content:'final',reasoning_content:''}];
 const before = structuredClone(messages);
 const options={model:'deepseek-v4.1-flash',messages,tools:[{}],supportsReasoning:true,effort:'max'};
 const body=encodeOpenAIChatRequest(options);
 assert.equal(body.messages[1].role,'user'); assert.match(body.messages[1].content,/old factual result/);
 assert.equal(body.messages[1].tool_calls,undefined);
 assert.equal(body.messages[2].reasoning_content,'native\nreasoning'); assert.equal(body.messages[3].tool_call_id,'current');
 assert.equal(body.messages[4].reasoning_content,''); assert.deepEqual(messages,before);
 for(const change of [{model:'gpt-6.1-sol'},{supportsReasoning:false},{effort:'off'},{tools:[]}]) {
  assert.equal(encodeOpenAIChatRequest({...options,...change}).messages[1].role,'assistant');
 }
});
