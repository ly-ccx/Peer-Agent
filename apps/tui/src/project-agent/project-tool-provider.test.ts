import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTuiHost, type TuiExecutionContext, type TuiHost } from '../tui-host.ts';
import { createProjectToolProvider } from './project-tool-provider.ts';
import type { RuntimeSdkHookRunner } from '@peer-agent/runtime-sdk';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
function fixture(hookRunner: RuntimeSdkHookRunner | null) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-project-tools-'));
  cleanup.push(() => rmSync(rootDir, {recursive:true,force:true}));
  let calls=0;
  const provider=createProjectToolProvider({rootDir, supervisor:{list(){calls++;return {ok:true,items:[]};}},
    objectives:{},replyComposer:{},verification:{},proactivity:{},checkModel:()=>({ok:true}),memoryEnabled:()=>true});
  cleanup.push(()=>provider.dispose());
  const host: TuiHost=createTuiHost({workspaceRoot:rootDir,userDataPath:rootDir,providers:[provider],hookRunner});
  cleanup.push(()=>host.dispose());
  const context:TuiExecutionContext={sessionId:'session',conversationId:'conversation',turnId:'turn',turnIndex:0,
    mode:'project_agent',toolContext:{workspaceId:'workspace',role:'project_agent'},
    project:{workspaceId:'workspace',holdsLease:()=>true}};
  return {provider,host,context,calls:()=>calls};
}

test('project tools expose manifest-derived modes and reject an unprojected call',async()=>{
  const f=fixture(null);
  expect(f.provider.manifests.map(row=>row.capabilityId)).toEqual(f.provider.toolDefinitions.map(row=>row.capabilityId));
  expect(f.host.capabilitiesForMode!('project_agent')).toContain('local.delegation.list_sessions');
  expect(f.host.capabilitiesForMode!('chat')).not.toContain('local.delegation.list_sessions');
  const result=await f.host.execute('local.delegation.list_sessions',{}, {...f.context,mode:'chat'});
  expect(result.result.status).not.toBe('success');expect(f.calls()).toBe(0);
});

test('a project tool obeys Hook deny before provider dispatch and returns its factual evidence',async()=>{
  const f=fixture({runPreToolUse(){return [{hookId:'policy',decision:'deny',reason:'blocked'}];}});
  const result=await f.host.execute('local.delegation.list_sessions',{},f.context);
  expect(f.calls()).toBe(0);expect((result.grant as {granted?:boolean})?.granted).toBe(false);
  expect(result.result.status).toBe('denied');expect((result.result.evidence as any).hookFinalDecision).toBe('deny');
});

test('lease lost during an async Hook blocks the previously projected provider',async()=>{
  let held = true;
  const f=fixture({async runPreToolUse(){held=false;return [];}});
  const result=await f.host.execute('local.delegation.list_sessions',{}, {...f.context,project:{workspaceId:'workspace',holdsLease:()=>held}});
  expect(f.calls()).toBe(0);expect(result.result.status).toBe('denied');
});

test('Goal tool writes pass through the same Hook and lease gate',async()=>{
  const f=fixture({runPreToolUse(){return [{hookId:'deny-goal',decision:'deny'}];}});
  const result=await f.host.execute('local.goal.create_plan',{title:'must not persist',goal:'blocked'}, {...f.context,mode:'goal'});
  expect(result.result.status).toBe('denied');
  expect(f.host.goalBridge!.store.listPlans()).toHaveLength(0);
});

test('project Hook asks use the local approval port; readonly ephemeral turns cannot approve',async()=>{
  const f=fixture({runPreToolUse(){return [{hookId:'ask',decision:'ask',reason:'confirm'}];}});
  let approvals=0;
  const unsubscribe=f.host.subscribeApproval(approval=>{if(approval){approvals++;approval.resolve('allow-once');}});
  cleanup.push(unsubscribe);
  const readOnly=await f.host.execute('local.delegation.list_sessions',{}, {...f.context,
    project:{...f.context.project!,approver:false}});
  expect(readOnly.result.status).toBe('denied');expect(f.calls()).toBe(0);expect(approvals).toBe(0);
  const result=await f.host.execute('local.delegation.list_sessions',{},f.context);
  expect(result.result.status).toBe('success');expect(f.calls()).toBe(1);expect(approvals).toBe(1);
  expect(f.host.goalBridge!.store.findEvidenceIndexRecords([`tool-result://${result.result.toolCallId}`])[0]?.toolName).toBe('list_sessions');
});
