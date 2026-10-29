import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync,utimesSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInputQueue} from './input-queue.mjs';

test('unchanged queue reuses image validation, isolates callers and revalidates external changes and strict reads', t=>{
 const root=mkdtempSync(path.join(tmpdir(),'peer-input-cache-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const encoded=Buffer.from('hello').toString('base64'),queue=createInputQueue({rootDir:root});
 const input={workspaceId:'w',inputId:'i',surface:'desktop',text:'original',attachments:[{sourceKind:'user_upload',id:'image',kind:'image',mimeType:'image/png',size:5,dataUrl:'data:image/png;base64,'+encoded}]};
 queue.submitInput(input);queue.pendingExecution('w');
 const from=Buffer.from;let validations=0;
 Buffer.from=function(value,encoding,...rest){if(value===encoded&&encoding==='base64')validations++;return from.call(this,value,encoding,...rest);};
 try {
  for(let n=0;n<20;n++)queue.pendingExecution('w');assert.equal(validations,0);
  const first=queue.submitInput(input);first.attachments[0].dataUrl='forged';first.anchorRefs.push('forged');
  const next=queue.submitInput(input);assert.equal(next.attachments[0].dataUrl,input.attachments[0].dataUrl);assert.deepEqual(next.anchorRefs,[]);
  const file=path.join(root,'w/input-queue.jsonl'),before=statSync(file);
  const record=JSON.parse(readFileSync(file,'utf8'));record.text='modified';writeFileSync(file,JSON.stringify(record)+'\n');utimesSync(file,before.atime,before.mtime);
  assert.equal(queue.submitInput(input).text,'modified');assert.ok(validations>0);
  appendFileSync(file,'{broken\n');queue.pendingExecution('w');assert.throws(()=>queue.diagnosticSnapshot('w'),SyntaxError);
  rmSync(file);assert.deepEqual(queue.pendingExecution('w'),[]);
 } finally {Buffer.from=from;}
});
