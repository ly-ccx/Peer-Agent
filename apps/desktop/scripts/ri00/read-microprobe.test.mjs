import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMicroprobe } from './read-microprobe.mjs';

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
