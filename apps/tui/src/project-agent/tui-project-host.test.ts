import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createBotLifecycle, createProjectRegistry, createHostLease } from '@peer-agent/runtime-node';
import { createTuiProjectHost } from './tui-project-host.ts';
import { createTuiProjectClient } from './tui-project-client.ts';
import { createTuiHost } from '../tui-host.ts';
import { createProviderChatModel } from '../provider-chat-model.ts';
import { createTuiModelSelectionControl } from '../tui-model-selection.ts';
import { buildTuiSystemPrompt } from '../tui-language.ts';
import type { TuiRuntime } from '../tui-runtime.ts';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const provider = { id: 'configured', provider: 'openai', model: 'test-model', enabled: true,
  apiKeyConfigured: true, supportsTools: true, supportsStructured: true, isDefault: true };
function fixture() {
  const dataHome = mkdtempSync(path.join(os.tmpdir(), 'peer-tui-project-'));
  cleanups.push(() => rmSync(dataHome, { recursive: true, force: true }));
  const workspacePath = path.join(dataHome, 'workspace'); mkdirSync(workspacePath);
  writeFileSync(path.join(dataHome, 'llm-providers.json'), JSON.stringify([provider]));
  const registry = createProjectRegistry({ filePath: path.join(dataHome, 'projects/registry.json') });
  const entry = registry.ensureForPath(workspacePath);
  const conversations = createConversationStore({ storeDir: path.join(dataHome, 'conversations') });
  const lifecycle = createBotLifecycle({ rootDir: dataHome, registry, conversationStore: conversations } as never);
  const created = lifecycle.ensureBot(entry.workspaceId) as any;
  expect(created.ok).toBe(true);
  return { dataHome, workspacePath, workspaceId: entry.workspaceId, conversationId: created.profile.agentConversationId };
}
function start(f: ReturnType<typeof fixture>, executeTurn: (request: any) => Promise<any>) {
  const host = createTuiProjectHost({ ...f, autoStart: false, executeTurn,
    getSettings: () => ({ providers: [provider], projectAgent: { concurrency: 1 } }) });
  cleanups.push(() => host.close());
  return host;
}

test('terminal composition consumes a durable input once and projects its shared reply', async () => {
  const f = fixture(), calls: any[] = [];
  const host = start(f, async input => { calls.push(input); return { ok: true, text: 'received', toolCalls: [] }; });
  const client = createTuiProjectClient({ dataHome: f.dataHome, host, autoStart: false });
  cleanups.push(() => client.close());
  const receipt = client.submit('hello', { inputId: 'same-input' });
  expect(receipt.inputId).toBe('same-input');
  await host.tick();
  client.submit('different retry text', { inputId: 'same-input' }); await host.tick();
  const messages = client.poll(true).messages;
  expect(calls).toHaveLength(1);
  expect(messages.filter(row => row.id === 'input-same-input')).toHaveLength(1);
  expect(messages.find(row => row.id === 'input-same-input').content).toBe('hello');
  expect(messages.find(row => row.kind === 'agent_reply').content).toBe('received');
  expect(calls[0].turnProfile.role).toBe('project_agent');
  expect(calls[0].turnProfile.modelSelection.modelProviderId).toBe('configured');
});

test('a terminal client writes only the queue; active desktop owns consumption and approval', async () => {
  const f = fixture();
  const desktop = createHostLease({ rootDir: path.join(f.dataHome, 'project-runtime'), hostId: 'desktop', surface: 'desktop' } as never);
  desktop.acquire(f.workspaceId); cleanups.push(() => desktop.close());
  let turns = 0;
  const host = start(f, async () => { turns++; return { ok: true, text: 'must not run' }; });
  const client = createTuiProjectClient({ dataHome: f.dataHome, host, autoStart: false });
  cleanups.push(() => client.close());
  client.submit('queue me', { inputId: 'other-process' }); await host.tick();
  expect(turns).toBe(0);
  expect(client.poll(true).isHost).toBe(false);
  expect(client.poll().messages.some(row => row.id === 'input-other-process')).toBe(false);
  expect(await client.decide('approval', 'approve')).toEqual({ ok: false, error: 'desktop_approval_required' });
  desktop.close(); await host.tick();
  expect(turns).toBe(1);
});

test('unchanged client polls reuse the projection without rereading conversation bodies', async () => {
  const f = fixture(), host = start(f, async () => ({ ok: true, text: 'hello' }));
  const client = createTuiProjectClient({ dataHome: f.dataHome, host, autoStart: false });
  cleanups.push(() => client.close());
  const first = client.poll();
  const original = host.directory.readConversation;
  host.directory.readConversation = (() => { throw new Error('unchanged poll read a body'); }) as typeof original;
  expect(client.poll()).toBe(first);
  host.directory.readConversation = original;
});

test('a client input is consumed once by a host in a different process',async()=>{
  const f=fixture(), helper=path.join(f.dataHome,'host-child.ts');
  writeFileSync(helper,`import {createInterface} from 'node:readline';
import {createTuiProjectHost} from ${JSON.stringify(new URL('./tui-project-host.ts',import.meta.url).href)};
const host=createTuiProjectHost({dataHome:process.argv[2],workspacePath:process.argv[3],autoStart:false,
  getSettings:()=>({providers:[${JSON.stringify(provider)}],memory:{enabled:false}}),
  executeTurn:async()=>({ok:true,text:'child process received',toolCalls:[]})});
await host.tick();console.log('child-ready');
for await(const line of createInterface({input:process.stdin})){
 if(line==='close'){await host.close();break;}
 await host.tick();console.log('child-consumed');
}
`);
  const child=spawn(process.execPath,[helper,f.dataHome,f.workspacePath],{stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  cleanups.push(()=>{child.kill();});
  const lines=createInterface({input:child.stdout}), iterator=lines[Symbol.asyncIterator]();
  async function next(expected:string){
    const limit=Date.now()+4000;
    while(Date.now()<limit){const result=await Promise.race([iterator.next(),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error(`child timed out: ${stderr}`)),4000))]);
      if(result.done)throw new Error(`child exited: ${stderr}`);if(result.value===expected)return;}
  }
  await next('child-ready');
  const host=start(f,async()=>{throw new Error('client executed a turn');});
  const client=createTuiProjectClient({dataHome:f.dataHome,host,autoStart:false});cleanups.push(()=>client.close());
  client.submit('cross process',{inputId:'cross-process'});expect(client.poll(true).isHost).toBe(false);
  child.stdin.write('tick\n');await next('child-consumed');
  expect(client.poll(true).messages.filter(row=>row.kind==='agent_reply'&&row.content==='child process received')).toHaveLength(1);
  client.submit('duplicate retry',{inputId:'cross-process'});child.stdin.write('tick\n');await next('child-consumed');
  expect(client.poll(true).messages.filter(row=>row.id==='input-cross-process')).toHaveLength(1);
  expect(client.poll(true).messages.filter(row=>row.kind==='agent_reply'&&row.content==='child process received')).toHaveLength(1);
  const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()));child.stdin.write('close\n');child.stdin.end();await exited;lines.close();
},12000);

test('two terminal compositions start only one project turn and takeover preserves input', async () => {
  const f = fixture(), calls: string[] = [];
  const one = start(f, async () => { calls.push('one'); return { ok: true, text: 'first' }; });
  const two = start(f, async () => { calls.push('two'); return { ok: true, text: 'second' }; });
  one.inputs.submitInput({ workspaceId: f.workspaceId, inputId: 'first', text: 'first', surface: 'tui' });
  await Promise.all([one.tick(), two.tick()]);
  expect(calls).toEqual(['one']);
  expect((await two.takeover()).requested).toBe(true);
  one.leases.pulse(); await one.leases.awaitDrained();
  two.inputs.submitInput({ workspaceId: f.workspaceId, inputId: 'after-takeover', text: 'second', surface: 'tui' });
  await Promise.all([one.tick(), two.tick()]);
  expect(calls).toEqual(['one', 'two']);
  expect(two.holdsLease(f.workspaceId)).toBe(true);
  const history = two.conversations.getPersistedConversationHistory?.(f.conversationId)?.messages as any[];
  expect(history.filter(row => row.kind === 'user_input')).toHaveLength(2);
});

test('shared terminal composition completes delegation, real file evidence, independent verification and a governed reply',async()=>{
  const f=fixture();writeFileSync(path.join(f.workspacePath,'README.md'),'verified terminal fixture');
  let host:ReturnType<typeof createTuiProjectHost>;
  let sequence=0, verified=false;
  const call=(name:string,args:object)=>({content:'',toolCalls:[{id:`chain-${++sequence}`,name,arguments:JSON.stringify(args)}]});
  host=createTuiProjectHost({...f,autoStart:false,
    getSettings:()=>({providers:[provider],projectAgent:{concurrency:2},memory:{enabled:false}}),
    createRuntime(options){
      const toolHost=createTuiHost(options);
      const model=createProviderChatModel({model:'test-model',toolDefinitionsForMode:mode=>toolHost.toolDefinitionsForMode!(mode),
        getSystemPrompt:context=>buildTuiSystemPrompt({}, {...context.systemContextInput,mode:context.mode}),
        provider:{async stream(request){
          const content=request.messages.map(row=>typeof row.content==='string'?row.content:JSON.stringify(row.content)).join('\n');
          const lastToolRow=request.messages.filter(row=>row.role==='tool').at(-1) as any;
          const lastTool=lastToolRow ? {...lastToolRow,name:request.messages.flatMap((row:any)=>row.toolCalls ?? []).find((row:any)=>row.id===lastToolRow.toolCallId)?.name} : null;
          const plans=host.plans.listPlans().map((row:any)=>host.plans.getPlan(row.planId)).filter(Boolean);
          const plan=plans.find((row:any)=>row.delegationOrigin?.workspaceId===f.workspaceId);
          if(content.includes('Verifier mission for plan')){
            const refs=host.plans.listEvidenceIndex().filter((row:any)=>row.planId===plan?.planId&&row.bodyPreview?.text?.includes('verified terminal fixture')).map((row:any)=>row.evidenceRef);
            expect(refs.length).toBeGreaterThan(0);
            const text=JSON.stringify({passed:true,failedCriteria:[],missingEvidence:[],risks:[],evidenceRefs:[refs[0]],summary:'independent verification passed'});
            request.onEvent?.({type:'text.delta',content:text});return {content:text,toolCalls:[]};
          }
          if(content.includes('Explorer mission for plan')){
            if(!lastTool)return call('read_file',{path:'README.md'});
            const ref=`tool-result://${lastTool.toolCallId}`;
            const text=JSON.stringify({summary:'README.md is the primary project file',findings:[{claim:'README.md contains verified terminal fixture',evidenceRefs:[ref]}],evidenceRefs:[ref],recommendedNextStep:'Read README.md and verify its existence',confidence:'high'});
            request.onEvent?.({type:'text.delta',content:text});return {content:text,toolCalls:[]};
          }
          if(request.tools?.some(tool=>tool.name==='spawn_session')){
            const session=host.supervisor.sessionsForProject(f.workspaceId)[0];
            if(!session)return call('spawn_session',{anchorMessageIds:['input-chain'],title:'Read README',brief:'Read README.md and verify its contents',kind:'research',readOnly:true,isolation:'none',successCriteria:[{kind:'file-exists',description:'README exists',path:'README.md'}]});
            if(session.status==='result_ready'&&!verified){verified=true;return call('verify_session',{sessionId:session.sessionId});}
            if(lastTool?.name==='verify_session')return call('post_reply',{text:'已完成 README 检查并通过验收。',sources:[session.sessionId],replyTo:[],proactive:true,statusClaims:[{sessionId:session.sessionId,status:session.status}]});
            if(lastTool?.name==='post_reply')return {content:'',toolCalls:[]};
            if(lastTool?.name==='spawn_session'){
              expect(lastTool.content).toContain(session.sessionId);
              return call('post_reply',{text:'已开始检查 README。',sources:[session.sessionId],replyTo:['input-chain'],statusClaims:[{sessionId:session.sessionId,status:session.status}]});
            }
            return {content:'',toolCalls:[]};
          }
          if(!lastTool)return call('read_file',{path:'README.md'});
          if(lastTool.name==='read_file')return call('goal_update_task',{planId:plan!.planId,taskId:plan!.tasks[0].taskId,status:'completed',result:'README read',evidenceRefs:[`tool-result://${lastTool.toolCallId}`],criterionResults:[{criterionId:'c1',passed:true,evidenceRef:`tool-result://${lastTool.toolCallId}`,detail:'Real read confirms README exists'}]});
          return {content:'worker finished',toolCalls:[]};
        }}});
      return {host:toolHost,model,modelSelection:createTuiModelSelectionControl({providerId:'configured',modelId:'test-model',displayName:'test'}),dispose:()=>toolHost.dispose()} as unknown as TuiRuntime;
    }});
  cleanups.push(()=>host.close());
  const client=createTuiProjectClient({dataHome:f.dataHome,host,autoStart:false});cleanups.push(()=>client.close());
  client.submit('Read README and verify it',{inputId:'chain'});await host.tick();
  const deadline=Date.now()+6000;
  while(Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));await host.tick();
    if(client.poll(true).messages.some(row=>row.kind==='agent_reply'&&row.content.includes('通过验收')))break;}
  const snapshot=client.poll(true),session=snapshot.sessions[0];
  expect(session).toBeDefined();
  expect(snapshot.messages.some(row=>row.kind==='agent_reply'&&row.content.includes('通过验收'))).toBe(true);
  const plan=host.plans.getPlan(session.planId)!;
  expect(plan.hostVerification?.independentVerifier).toBe('passed');
  expect(host.plans.listEvidenceIndex().some((row:any)=>row.planId===plan.planId&&row.bodyPreview?.text==='verified terminal fixture')).toBe(true);
  const before=JSON.parse(JSON.stringify({status:plan.status,runner:plan.runner,origin:plan.delegationOrigin}));
  await host.close();
  const after=host.plans.getPlan(plan.planId)!;
  expect({status:after.status,runner:after.runner,origin:after.delegationOrigin}).toEqual(before);
},15000);
