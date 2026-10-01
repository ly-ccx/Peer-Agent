import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDiagnosticsExport } from './diagnostics-export.mjs';

test('read is pathless; export uses only native chosen target and cancellation writes nothing', async t => {
  const root=mkdtempSync(path.join(os.tmpdir(),'peer-diagnostic-save-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'chosen.json'),report={schemaVersion:1,bots:[]};let dialogs=0,reads=0;
  const service=createDiagnosticsExport({readReport:()=>{reads++;return report;},chooseTarget:async()=>{dialogs++;return {canceled:true};}});
  assert.deepEqual(await service.execute({action:'read'}),{ok:true,report});assert.equal(dialogs,0);
  assert.equal((await service.execute({action:'export'})).cancelled,true);assert.deepEqual(readdirSync(root),[]);
  for(const payload of [{action:'export',filePath:file},{action:'read',workspaceId:'other'},null,{action:'write'}]) assert.deepEqual(await service.execute(payload),{ok:false,code:'INVALID_INPUT'});
  assert.equal(reads,2);assert.equal(dialogs,1);
  const save=createDiagnosticsExport({readReport:()=>report,chooseTarget:async()=>({canceled:false,filePath:file})});
  const result=await save.execute({action:'export'});assert.equal(result.saved,true);assert.equal(JSON.stringify(result).includes(file),false);
  assert.deepEqual(JSON.parse(readFileSync(file)),report);assert.deepEqual(readdirSync(root),['chosen.json']);
});
test('read/save failures expose fixed codes, remove temporary files and preserve an existing destination', async t => {
  const root=mkdtempSync(path.join(os.tmpdir(),'peer-diagnostic-failure-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'chosen.json');writeFileSync(file,'original');
  const read=createDiagnosticsExport({readReport(){throw Error('/private/sk-123456789');},chooseTarget(){throw Error('must not open');}});
  assert.deepEqual(await read.execute({action:'export'}),{ok:false,code:'DIAGNOSTICS_UNAVAILABLE'});
  const save=createDiagnosticsExport({readReport:()=>({bots:[]}),chooseTarget:async()=>({canceled:false,filePath:file}),
    rename(){throw Error('/private/sk-123456789');}});
  assert.deepEqual(await save.execute({action:'export'}),{ok:false,code:'DIAGNOSTICS_SAVE_FAILED'});
  assert.equal(readFileSync(file,'utf8'),'original');assert.deepEqual(readdirSync(root),['chosen.json']);
});
