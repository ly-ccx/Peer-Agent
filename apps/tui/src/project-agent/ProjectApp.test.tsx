import {expect,test} from 'bun:test';
import {act} from 'react';
import {testRender} from '@opentui/react/test-utils';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {runInteractiveValidation} from '@peer-agent/runtime-node/interactive-results';
import {interactiveArtifactRef} from '@peer-agent/protocol';
import {createTuiThemeStore} from '../tui-theme.ts';
import {createTuiProjectHost} from './tui-project-host.ts';import {createTuiProjectClient} from './tui-project-client.ts';import {ProjectApp} from './ProjectApp.tsx';
async function harness(initialView:'bind'|'bots'|'conversation'='bind') {
  const root=mkdtempSync(path.join(os.tmpdir(),'peer-terminal-surface-')),workspace=path.join(root,'project');mkdirSync(workspace);
  writeFileSync(path.join(root,'llm-providers.json'),JSON.stringify([{id:'configured',provider:'openai',model:'fixture',enabled:true,apiKeyConfigured:true,supportsTools:true,supportsStructured:true,isDefault:true}]));
  const host=createTuiProjectHost({dataHome:root,workspacePath:workspace,autoStart:false,getSettings:()=>({memory:{enabled:false}}),executeTurn:async({plan}:{plan:any})=>({ok:true,toolCalls:[{name:'post_reply',input:{text:'scripted UI reply',...(plan.userInputs?.length?{replyTo:[`input-${plan.userInputs[0].inputId}`]}:{proactive:true})},result:{ok:true}}]})});
  const client=createTuiProjectClient({dataHome:root,host,autoStart:false});let classic=0;
  if(initialView!=='bind'){
    const entry=host.registry.ensureForPath(workspace);
    host.lifecycle.ensureBot(entry.workspaceId);
    await client.select(entry.workspaceId);
  }
  const setup=await testRender(<ProjectApp host={host} client={client} initialView={initialView} workspacePath={workspace} locale="en-US" themeStore={createTuiThemeStore({userDataPath:root,systemThemeWatch:false})} onClassic={async()=>{classic++;}} onQuit={()=>{}}/>,{width:90,height:30});
  async function frame(){await act(async()=>{await Bun.sleep(25);});await setup.flush();await setup.renderOnce();return setup.captureCharFrame();}
  return {host,client,setup,frame,press:async(key:Parameters<typeof setup.mockInput.pressKey>[0])=>{await act(async()=>{setup.mockInput.pressKey(key);await Bun.sleep(20);});},type:async(text:string)=>{await act(async()=>{await setup.mockInput.typeText(text);});},classic:()=>classic,async close(){await act(async()=>{setup.renderer.destroy();});client.close();await host.close();rmSync(root,{recursive:true,force:true});}};
}
test('the bind screen keeps the question, choices, and keys in one block',async()=>{
  const f=await harness();
  try{
    const frame=await f.frame();
    const question=frame.indexOf('Bind this directory to a bot?');
    expect(question).toBeGreaterThan(-1);
    expect(frame.indexOf('Yes, create a bot')).toBeGreaterThan(question);
    expect(frame.indexOf('No, open task mode')).toBeGreaterThan(question);
    expect(frame).toContain('←/→ to choose · Enter to confirm · Esc for task mode');
    expect(frame).not.toContain('F2 · Task mode');
    expect(frame.split('\\n').filter(line=>line.includes('Yes, create a bot')&&line.includes('No, open task mode'))).toHaveLength(1);
  }finally{await f.close();}
});
test('typing reaches the composer after a click away from it',async()=>{
  const f=await harness('conversation');
  try{
    await f.frame();
    await act(async()=>{await f.setup.mockMouse.click(4,4);});
    await f.type('hello');
    expect(await f.frame()).toContain('hello');
  }finally{await f.close();}
});
test('binding refusal enters classic without creating any bot',async()=>{
  const f=await harness();try{expect(await f.frame()).toContain('Bind this directory');await f.press('n');await f.frame();
    expect(f.classic()).toBe(1);expect(f.host.directory.list()).toHaveLength(0);
  }finally{await f.close();}
});
for(const view of ['conversation','bots'] as const)test(`F2 opens task mode from a bound bot ${view} without unbinding`,async()=>{
  const f=await harness(view);try{
    const workspaceId=f.host.workspaceId();
    const profile=f.host.profiles.read(workspaceId);
    const frame=await f.frame();
    expect(profile?.status).toBe('active');
    expect(profile?.displayName).toBeTruthy();
    expect(frame).toContain(profile!.displayName);
    expect(frame).toContain(view==='conversation'?'Message this bot, or /help':'Up/down to select');
    expect(frame).not.toContain('Bind this directory');
    await f.press('F2');await f.frame();
    expect(f.classic()).toBe(1);
    expect(f.host.profiles.read(workspaceId)?.status).toBe('active');
  }finally{await f.close();}
});
test('binding, message submission, list navigation and cards work through the actual terminal renderer',async()=>{
  const f=await harness();try{
    await f.frame();await f.press('y');await act(async()=>{await f.host.tick();await f.client.poll();});expect(await f.frame()).toContain('Running here');expect(f.host.directory.list()).toHaveLength(1);
    await f.type('hello');await f.press('RETURN');await act(async()=>{await Bun.sleep(1100);});
    const reply=await f.frame();expect(reply).toContain('hello');expect(reply).toContain('scripted UI reply');expect(reply).toContain('Received');
    await f.type('/bots');await f.press('RETURN');expect(await f.frame()).toContain('Up/down to select');
    await f.press('RETURN');await f.frame();
    await f.type('/cards');await f.press('RETURN');expect(await f.frame()).toContain('Needs you');
    await f.press('ESCAPE');await f.frame();
    await f.type('/classic');await f.press('RETURN');await f.frame();expect(f.classic()).toBe(1);
  }finally{await f.close();}
});

test('task report opens the stored fixed result and displays a bounded computed table',async()=>{
  const f=await harness('conversation');
  try {
    const workspaceId=f.host.workspaceId(), conversationId=f.host.profiles.read(workspaceId)!.agentConversationId;
    const owner={workspaceId,conversationId};
    const child=f.host.conversations.createConversation({role:'work_session',workspaceId});
    const sessionId='result-session';
    const model={modelProviderId:'configured',providerId:'fixture',modelId:'fixture',family:'fixture'};
    const plan=f.host.plans.createPlan({conversationId:child.id,title:'Table report',status:'executing',
      tasks:[{taskId:'table',title:'Table',status:'pending'}],delegationOrigin:{workspaceId,parentConversationId:conversationId,
        sessionId,phase:'running',anchorMessageId:'anchor',inputId:'input',
        modelSelection:{worker:model,explorer:model,verifier:model,resolvedAt:new Date().toISOString()}}});
    const draft={publication:{kind:'create' as const},title:'Fixed trial',textFallback:'Model summary only',inputs:[],
      program:'root=Table("Options",[{key:"name",label:"Name"},{key:"cost",label:"Cost"}],@Data("rows"),"name")'};
    const content=await runInteractiveValidation({operation:'validate',draft,bindings:{rows:[{name:'Trial row',cost:20},...Array.from({length:30},(_,i)=>({name:`Next option ${i+1}`,cost:i}))]}});
    const source={conversationId:child.id,sessionId,planId:plan.planId,executionEpoch:'epoch',toolCallId:'publish-table'};
    const store=f.host.interactive.resultStore;
    const publication=store.commitPublication({owner,source,draft,content,provenance:[],dataLevel:'D3_private',
      grant:{granted:true,toolCallId:source.toolCallId,grantId:'fixture'}},()=>true);
    f.host.plans.recordEvidenceRefs(publication.indexEntry, {durable:true});
    store.markIndexed(publication.callRef,publication.indexEntry);
    const ref=interactiveArtifactRef(publication.reference);
    f.host.plans.recordTaskEvidence(plan.planId,'table',{status:'completed',result:'Table published',evidenceRefs:[ref]});
    await act(async()=>{await f.client.poll();await Bun.sleep(1100);});
    await f.frame();await f.type('/task 1');await f.press('RETURN');
    expect(await f.frame()).toContain('/result 1');
    await f.type('/result 1');await f.press('RETURN');
    let frame='';
    for(let attempt=0;attempt<15&&!frame.includes('Trial row');attempt++) frame=await f.frame();
    expect(frame).toContain('Computed from initial conditions');
    expect(frame).toContain('Trial row | 20');
    expect(frame).toContain('Saved model summary');
    await f.press('\x1b[6~');
    expect(await f.frame()).toContain('Next option 10');
    await f.press('ESCAPE');
    expect(await f.frame()).not.toContain('Trial row');
    expect(f.host.plans.listEvidenceIndex().map(row=>row.evidenceRef)).toEqual([ref]);
    await expect(f.host.readTaskResult('unknown-session',ref,new AbortController().signal)).rejects.toThrow('interactive_scope_denied');
    const controller=new AbortController();
    const pending=f.host.readTaskResult(sessionId,ref,controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('interactive_scope_denied');
  }finally{await f.close();}
});
