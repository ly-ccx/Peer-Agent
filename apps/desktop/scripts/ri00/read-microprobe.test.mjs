import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMicroprobe, evidenceReadPoint } from './read-microprobe.mjs';

test('context microprobe keeps selected data private and leaves source files unchanged',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-microprobe-'));
  try{
    for(let i=0;i<5;i++)fs.writeFileSync(path.join(root,`private-plan-${i}.json`),'private body');
    const before=fs.readdirSync(root).map(name=>fs.readFileSync(path.join(root,name),'utf8'));
    const result=readMicroprobe.call({getStoreDir:()=>root,getPlan:()=>({status:'completed',runner:{status:'completed'},tasks:[],updatedAt:'fixed'})});
    assert.equal(result.selectedFiles,5);assert.equal(result.cases.pathJoin.length,3);
    assert.equal(JSON.stringify(result).includes('private-plan'),false);
    assert.equal(JSON.stringify(result).includes('private body'),false);
    assert.deepEqual(fs.readdirSync(root).map(name=>fs.readFileSync(path.join(root,name),'utf8')),before);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('evidence points bind strong file identity and expose counts without record content',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-evidence-point-'));
  try{
    fs.writeFileSync(path.join(root,'evidence-index.jsonl'),'private evidence body');
    const point=evidenceReadPoint.call({getStoreDir:()=>root,listEvidenceIndex:()=>[{secret:'private evidence body'}]});
    assert.equal(point.rows,1);assert.equal(point.sourceStable,true);assert.equal(point.sourceBefore.length,64);
    assert.equal(JSON.stringify(point).includes('private'),false);
    assert.throws(()=>evidenceReadPoint.call({getStoreDir:()=>root,listEvidenceIndex:()=>{throw new Error('damaged')}}),/damaged/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
