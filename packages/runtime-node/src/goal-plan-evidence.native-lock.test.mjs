import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGoalPlanEvidence } from './goal-plan-evidence.mjs';

test('Evidence index respects native writer locks without losing registered facts', t => {
 const root=mkdtempSync(join(tmpdir(),'peer-evidence-lock-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const s=createGoalPlanEvidence({storeDir:root,getActivePlanByConversation:()=>null});
 s.recordEvidenceRefs({evidenceRefs:['evidence://first'],toolCallId:'first',createdAt:'2026-11-14T00:00:00.000Z'},{durable:true});
 const file=join(root,'evidence-index.jsonl'),before=readFileSync(file);mkdirSync(file+'.lock');
 assert.throws(()=>s.recordEvidenceRefs({evidenceRefs:['evidence://next']}),{code:'STORE_LOCK_BUSY'});
 assert.deepEqual(readFileSync(file),before);assert.equal(s.findEvidenceIndexRecords(['evidence://first']).length,1);
});
