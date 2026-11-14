import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redirectOwnedObligationLog } from './e3-owned-log-sink.mjs';
import { guardReadOnlySource } from './readonly-coordination.mjs';
import { appendObligationLog } from '../../../../packages/runtime-node/src/project-agent/obligation-log.mjs';

test('only the fixed owned log sink is redirected; canonical writes remain denied and owners restore',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'e3-log-sink-')),source=path.join(root,'source'),output=path.join(root,'output');fs.mkdirSync(source);fs.mkdirSync(output);
  const guard=guardReadOnlySource([source]),sink=redirectOwnedObligationLog(source,output);
  try{appendObligationLog({event:'fixture'},{PEER_AGENT_HOME:source});
    assert.ok(fs.existsSync(path.join(output,'logs/obligation.log')));assert.equal(fs.existsSync(path.join(source,'logs')),false);
    assert.equal(guard.state.sourceWritesDenied,0);assert.throws(()=>fs.writeFileSync(path.join(source,'canonical'),'bad'));assert.equal(guard.state.sourceWritesDenied,1);
    assert.equal(sink.close().restored,true);
  }finally{sink.close();guard.close();fs.rmSync(root,{recursive:true,force:true});}
});
