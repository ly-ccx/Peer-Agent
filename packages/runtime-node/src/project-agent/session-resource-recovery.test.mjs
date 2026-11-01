import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionControl } from './session-control.mjs';
import { createExecutionScheduler } from './execution-scheduler.mjs';

test('the legacy cancelled/stopping shape retires its takeover and admits an independent queued worktree without replay', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-session-resource-recovery-'));
  const main = path.join(root,'main'), tree = path.join(root,'tree'); mkdirSync(main); mkdirSync(tree);
  let old = { planId:'old', conversationId:'old-conversation', status:'cancelled', targetWorkspacePath:main, createdAt:'created', runner:{status:'paused'},
    delegationOrigin:{sessionId:'old-session',workspaceId:'workspace',parentConversationId:'parent',phase:'paused',
      cancellation:{operationId:'old-cancel',phase:'completed',completedAt:'2026-11-01T00:00:00.000Z',disposition:'user_withdrawn',preserveArtifacts:true,
        evidenceCalls:['historical-unknown'], withdrawal:{workspaceId:'workspace',parentConversationId:'parent',sessionId:'old-session',planId:'old',anchorMessageId:'input',inputId:'input'}},
      takeover:{operationId:'old-takeover',phase:'stopping'}}};
  const fresh = {planId:'new',conversationId:'new-conversation',status:'paused',targetWorkspacePath:main,createdAt:'new-created',
    deliveryBinding:{executionIsolation:'worktree',worktreePath:tree},
    delegationOrigin:{sessionId:'new-session',workspaceId:'workspace',parentConversationId:'parent',phase:'queued'}};
  const goalPlanStore = {getPlan: id=>structuredClone(id==='old'?old:fresh),
    revisePlan(_id,patch){old={...old,...structuredClone(patch)};},setPlanStatus(_id,status){old.status=status;}};
  const scheduler = createExecutionScheduler({rootDir:path.join(root,'runtime')});
  scheduler.configure({currentPlan:p=>goalPlanStore.getPlan(p.planId),ownsWorkspace:()=>true});
  t.after(()=>{scheduler.close();rmSync(root,{recursive:true,force:true});});
  const control=createSessionControl({goalPlanStore,executionScheduler:scheduler,canManageWorkspace:()=>true,
    goalRunner:{pause(){},async waitForIdle(){}},readMessages:()=>[{id:'input',inputId:'input',role:'user',kind:'user_input'}]});
  scheduler.reconcile([old,fresh]);
  await control.reconcile([old,fresh]);
  assert.equal(old.delegationOrigin.takeover.phase,'superseded');
  assert.equal(old.delegationOrigin.executionControl.phase,'settled');
  assert.deepEqual(old.delegationOrigin.cancellation.evidenceCalls,['historical-unknown']);
  assert.deepEqual(scheduler.select([old,fresh]).start.map(p=>p.planId),['new']);
  const sameDirectory = {...fresh,planId:'conflict',delegationOrigin:{...fresh.delegationOrigin,sessionId:'conflict'},deliveryBinding:{executionIsolation:'none'}};
  assert.equal(scheduler.inspect(sameDirectory).blocker.code,'execution_outcome_unknown');
});
