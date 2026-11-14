import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createTrace } from './trace.mjs';
import { seedRi00 } from './seed.mjs';
import { createReadHost } from './read-host.mjs';

test('all source stores require the read-only source guard before any production assembly',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'peer-ri00-source-admission-')),previous=process.env.PEER_AGENT_HOME;
  try{
    process.env.PEER_AGENT_HOME=home;
    await assert.rejects(createReadHost({fixtureRoot:home,sourceStores:true,coordinationLiveRoot:path.join(home,'project-runtime')}),/source_stores_require_readonly_source_guard/);
  }finally{if(previous===undefined)delete process.env.PEER_AGENT_HOME;else process.env.PEER_AGENT_HOME=previous;fs.rmSync(home,{recursive:true,force:true});}
});

test('counter adapter observes real production detailed-session host dependencies', async () => {
  const require = createRequire(import.meta.url);
  const moduleRoot = path.resolve(path.dirname(require.resolve('@peer-agent/runtime-node')), '../../..');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-ri00-contract-'));
  try {
    await seedRi00({ moduleRoot, home, plans: 30, sessions: 4, ready: 2, evidence: 25 });
    const counts = [];
    for (const bindings of [false, true]) {
      const trace = createTrace();
      const host = await createReadHost({ moduleRoot, fixtureRoot: home, bindings, trace });
      try {
        await trace.request('query', () => host.sessionFacts());
        const [row] = trace.take(); counts.push(row.counts);
        assert.equal(host.fixtureObservation.minSessions, 4);
      } finally { host.close(); }
    }
    assert.equal(counts[0].listEvidenceIndex, 2);
    assert.equal(counts[1].listEvidenceIndex, 4);
    assert.equal(counts[0].evidenceRows, 50);
    assert.equal(counts[1].evidenceRows, 100);
    assert.ok(counts[1].getPlan > counts[0].getPlan);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
