import test from 'node:test';
import assert from 'node:assert/strict';
import {sendOpenAIChatStream} from '../dist/provider-adapters/openai-chat-adapter.mjs';

test('chat adapter HTTP errors use safe diagnostics instead of raw body',async()=>{
 const result=await sendOpenAIChatStream({baseUrl:'https://fixture.invalid/v1',apiKey:'fixture-secret',model:'fixture',messages:[{role:'user',content:'PRIVATE_PROMPT_ECHO'}],tools:[],tracePrivacy:'metadata_only',fetchWithRecovery:async()=>new Response('<html>fixture-secret PRIVATE_PROMPT_ECHO</html>',{status:503})});
 assert.equal(result.ok,false);assert.equal(result.status,503);
 assert.doesNotMatch(result.errorText,/fixture-secret|PRIVATE_PROMPT_ECHO|html/);
 assert.equal(result.errorText,'HTTP 503');
});
