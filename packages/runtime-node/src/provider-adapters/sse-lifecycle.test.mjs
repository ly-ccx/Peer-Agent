import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeOpenAIStream } from '../../dist/provider-adapters/openai-chat-adapter.mjs';
import { throwIfSseReaderAborted } from './sse-line.mjs';
const within = promise => Promise.race([promise, new Promise(resolve => setTimeout(()=>resolve('HUNG'), 60))]);

test('compatibility stream delivers completed tool calls at DONE even when connection and cancel never finish', async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"actual","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\n\ndata: [DONE]\n\n');
  let reads = 0, cancelled = 0;
  const reader = { read: () => ++reads === 1 ? Promise.resolve({done:false,value:bytes}) : new Promise(()=>{}), cancel: () => {cancelled++;return new Promise(()=>{});} };
  const result = await within(consumeOpenAIStream({body:{getReader:()=>reader}}, {send(){}}, 'actual', null, null, {streamIdleTimeoutMs:20}));
  assert.notEqual(result, 'HUNG'); assert.equal(result.toolCalls[0].name,'read_file');assert.equal(reads,1);assert.equal(cancelled,1);
});

test('already-aborted SSE consumption does not wait for transport cancellation to resolve', async () => {
  const controller = new AbortController(); controller.abort();let cancelled=0;
  const result = await within(throwIfSseReaderAborted(controller.signal,{cancel(){cancelled++;return new Promise(()=>{});}}).then(()=>null,e=>e.name));
  assert.equal(result,'AbortError');assert.equal(cancelled,1);
});

for (const mode of ['abort', 'timeout']) test(`pending read and non-settling cleanup cannot block ${mode}`, async () => {
  const { readSseChunk } = await import('./sse-line.mjs');
  const controller = new AbortController(); let release, cancelled=0;
  const reader={read:()=>new Promise(resolve=>{release=resolve;}),cancel:()=>{cancelled++;return new Promise(()=>{});}};
  const pending=readSseChunk(reader,controller.signal,mode==='timeout'?10:0).then(()=>null,error=>error);
  if(mode==='abort')setTimeout(()=>controller.abort(),10);
  const error=await within(pending);
  assert.notEqual(error,'HUNG');assert.equal(mode==='abort'?error.name:error.type,mode==='abort'?'AbortError':'provider_stream_idle_timeout');
  assert.equal(cancelled,1);release({done:false,value:new TextEncoder().encode('late')});
});
