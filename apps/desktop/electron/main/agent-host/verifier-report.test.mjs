import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeVerifierReport, finalVerifierText, runVerifierWithReport } from './verifier-report.mjs';

const report = { passed: true, failedCriteria: [], missingEvidence: [], risks: [], evidenceRefs: ['ev-1'] };
const json = JSON.stringify(report);
const delta = content => ({ channel: 'chat:stream:delta', payload: { content } });
const done = { channel: 'chat:stream:done', payload: {} };

test('accepts one complete report, JSON fences and prose without swallowing JSON string braces', () => {
  for (const text of [json, `\`\`\`json\n${json}\n\`\`\``, `Report:\n${JSON.stringify({...report,summary:'read {a} and "b"'})}\nEnd.`]) {
    assert.equal(decodeVerifierReport(text).passed, true);
  }
});

test('rejects ambiguous, incomplete and ill-typed reports instead of promoting them to a pass', () => {
  for (const text of ['', 'done', `${json}\n${json}`, `{invalid}\n${json}`, `${json}\n{"passed":`, JSON.stringify([report]),
    JSON.stringify({...report,passed:'true'}), JSON.stringify({...report,evidenceRefs:'ev-1'}),
    JSON.stringify({...report,failedCriteria:[{reason:4}]}), JSON.stringify({...report,risks:null})]) {
    assert.equal(decodeVerifierReport(text), null, text);
  }
});

test('only final assistant deltas count; tools and reasoning cannot supply the report', () => {
  const events = [delta(json), {channel:'chat:stream:tool-call',payload:{}},
    {channel:'chat:stream:tool-result',payload:{result:json}}, {channel:'chat:stream:thinking',payload:{content:json}},
    delta('Report: '), delta(json), done];
  assert.equal(finalVerifierText(events), `Report: ${json}`);
  assert.equal(finalVerifierText(events.slice(0,4)), '');
});

test('format retry is bounded and receives only bounded untrusted text', async () => {
  const inputs = [];
  const result = await runVerifierWithReport({run: async input => {
    inputs.push(input); return {events:[delta(input.attempt ? json : 'x'.repeat(5000)),done]};
  }});
  assert.equal(result.passed,true); assert.equal(inputs.length,2); assert.equal(inputs[1].previousText.length,4000);
  let count=0;
  const invalid=await runVerifierWithReport({run:async()=>{count++;return {events:[delta('done'),done]};}});
  assert.equal(count,2);assert.equal(invalid.error,'verifier_report_invalid');assert.equal(invalid.passed,false);
  assert.deepEqual(invalid.evidenceRefs,[]);
});

test('genuine failure, provider error, cancellation and denial never receive format recovery', async () => {
  let count=0;
  const failed=await runVerifierWithReport({run:async()=>{count++;return {events:[delta(JSON.stringify({...report,passed:false})),done]};}});
  assert.equal(failed.passed,false);assert.equal(count,1);
  for (const response of [{events:[delta(json),{channel:'chat:stream:error',payload:{error:'offline'}}]},
    {events:[delta(json),done],outcome:{terminalStatus:'interrupted'}},
    {events:[{channel:'chat:stream:aborted',payload:{}}]},
    {events:[{channel:'chat:stream:tool-result',payload:{result:JSON.stringify({status:'denied'})}},done]}]) {
    count=0;
    await assert.rejects(runVerifierWithReport({run:async()=>{count++;return response;}}));
    assert.equal(count,1);
  }
  const controller=new AbortController();count=0;
  await assert.rejects(runVerifierWithReport({signal:controller.signal,run:async()=>{
    count++;controller.abort();return {events:[delta(json),done]};
  }}),{name:'AbortError'});assert.equal(count,1);
});
