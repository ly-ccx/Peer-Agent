import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExecutionScheduler, registerWorkBudget, type ModelProvider } from '@peer-agent/runtime-node';
import { createTuiHost, type TuiHost } from '../tui-host.ts';
import { createProviderChatModel } from '../provider-chat-model.ts';
import { createTuiModelSelectionControl } from '../tui-model-selection.ts';
import { buildTuiSystemPrompt } from '../tui-language.ts';
import { createTuiTurnExecutor } from './tui-turn-executor.ts';
import type { TuiRuntime } from '../tui-runtime.ts';
import type { TuiTurnRequest } from './tui-turn-executor.ts';
import { createProjectToolProvider } from './project-tool-provider.ts';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
function harness(provider: ModelProvider, extra: Partial<Parameters<typeof createTuiTurnExecutor>[0]> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'peer-tui-turn-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const requests: any[] = [], hosts: TuiHost[] = [], persisted: any[] = [];
  const scheduler = createExecutionScheduler();
  const executor = createTuiTurnExecutor({ dataHome: home, getSettings: () => ({}),
    holdsLease: () => true, resolveWorkspacePath: () => home, readMessages: () => [],
    readMemory: () => [], memoryEnabled: () => true, getProviders: () => [], scheduler,
    persistTurn: (_input, output) => persisted.push(output),
    createRuntime(options) {
      const host = createTuiHost({ ...options, accessLevel: 'restricted_local' }); hosts.push(host);
      return { host, modelSelection: createTuiModelSelectionControl({providerId:'configured',modelId:'test-model',displayName:'test'}),
        model: createProviderChatModel({ provider: { stream(request) { requests.push(request); return provider.stream(request); } },
          model:'test-model', toolDefinitionsForMode: mode => host.toolDefinitionsForMode!(mode),
          getSystemPrompt: context => buildTuiSystemPrompt({}, { ...context.systemContextInput, mode: context.mode }),
        }), dispose: () => host.dispose(),
      } as unknown as TuiRuntime;
    }, ...extra });
  cleanup.push(() => executor.stop());
  const input: TuiTurnRequest = {conversationId:'conversation',streamId:'turn',workspaceId:'workspace',
    mode:'project_agent', messages:[{role:'user',content:'read README'}],turnProfile:{role:'project_agent',workspaceId:'workspace'},
    sink:{send(){}},ephemeral:true};
  return {home,executor,input,requests,hosts,persisted,scheduler};
}

test('the turn pipeline executes a real readonly provider and returns its Grant and Evidence', async () => {
  let rounds=0;
  const env=harness({async stream(){return ++rounds===1
    ? {content:'',toolCalls:[{id:'read',name:'read_file',arguments:JSON.stringify({path:'README.md'})}]}
    : {content:'done',toolCalls:[]};}});
  writeFileSync(path.join(env.home,'README.md'),'real file');
  const outcome=await env.executor.runTurn(env.input);
  expect(outcome.error).toBeUndefined();
  expect(outcome.ok).toBe(true);
  expect(outcome.toolCalls).toHaveLength(1);
  expect(outcome.error).toBeUndefined();
  expect(outcome.toolCalls[0].execution.grant.granted).toBe(true);
  expect(outcome.toolCalls[0].execution.result.status).toBe('completed');
  expect(JSON.stringify(outcome.toolCalls[0].execution.result)).toContain('real file');
  expect(outcome.toolCalls[0].execution.result.evidence).toBeDefined();
  expect(env.requests[0].tools.some((tool:any)=>tool.name==='bash'||tool.name==='write_file')).toBe(false);
  expect(env.requests[0].messages.some((row:any)=>String(row.content).includes('Project agent working rules'))).toBe(true);
});

test('TUI requires the tool checkpoint commit before another model request', async () => {
  let rounds = 0;
  const env = harness({ async stream() { return ++rounds === 1
    ? { content: '', toolCalls: [{ id: 'read', name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) }] }
    : { content: 'done', toolCalls: [] }; } });
  writeFileSync(path.join(env.home, 'README.md'), 'confirmed read');
  const works: Record<string, any> = { work: { schemaVersion: 1, workspaceId: 'workspace', workId: 'work',
    state: 'runnable', revision: 1 } };
  const store = { assertOwner() {}, read: () => ({ works: structuredClone(works) }),
    saveWork(work: any) { works.work = structuredClone(work); },
    checkpoint() { throw new Error('fixture checkpoint disk failure'); } };
  cleanup.push(registerWorkBudget('workspace', store));
  const outcome = await env.executor.runTurn({ ...env.input, turnProfile: { ...env.input.turnProfile, workId: 'work' } });
  expect(outcome.ok).toBe(false);
  expect(outcome.error).toBe('fixture checkpoint disk failure');
  expect(env.requests).toHaveLength(1);
  expect(outcome.toolCalls).toHaveLength(1);
  expect(works.work.budget.uncertainDispatches).toHaveLength(1);
  expect(works.work.budget.uncertainDispatches[0].toolCallId).toBe('read');
});

test('a hallucinated write is denied before the provider despite a project turn', async () => {
  let rounds=0;
  const env=harness({async stream(){return ++rounds===1
    ? {content:'',toolCalls:[{id:'write',name:'write_file',arguments:JSON.stringify({path:'forbidden',content:'wrong'})}]}
    : {content:'done',toolCalls:[]};}});
  await env.executor.runTurn(env.input);
  expect(env.requests[0].tools.some((tool:any)=>tool.name==='write_file')).toBe(false);
  const direct=await env.hosts[0]!.execute('local.file.write',{path:'forbidden',content:'wrong'},
    {sessionId:'direct',turnId:'direct-turn',turnIndex:0,mode:'project_agent',project:{workspaceId:'workspace',holdsLease:()=>true}});
  expect(direct.result.status).toBe('denied');
});

test('ephemeral readonly reviewers can read without a human approver and cannot write', async () => {
  let rounds=0;
  const env=harness({async stream(){return ++rounds===1
    ? {content:'',toolCalls:[{id:'read',name:'read_file',arguments:JSON.stringify({path:'README.md'})}]}
    : {content:'verified',toolCalls:[]};}});
  writeFileSync(path.join(env.home,'README.md'),'reviewed');
  const outcome=await env.executor.runTurn({...env.input,mode:'explorer',turnProfile:{role:'work_session',workspaceId:'workspace',sessionId:'session'},plan:{delegationOrigin:{readOnly:true}}});
  expect(outcome.error).toBeUndefined();
  expect(outcome.toolCalls[0].execution.grant.granted).toBe(true);
  expect(env.requests[0].tools.some((tool:any)=>tool.name==='write_file')).toBe(false);
});

test('scheduler cancellation aborts a running provider and waits for the old stream to settle', async () => {
  let entered!: () => void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  let stopped=false;
  const env=harness({stream(request){entered();return new Promise((_resolve,reject)=>{
    request.signal?.addEventListener('abort',()=>{stopped=true;reject(new DOMException('Aborted','AbortError'));},{once:true});
  });}});
  const pending=env.executor.runTurn({...env.input,turnProfile:{role:'project_agent',workspaceId:'workspace',planId:'plan'}});
  await started;env.scheduler.cancelPlan('plan');
  const outcome=await pending;
  expect(stopped).toBe(true);expect(outcome.terminalStatus).toBe('aborted');
});

test('delegated TUI turns receive their current plan admission and keep readonly capability gates', async () => {
  const env = harness({ async stream() { return { content: 'task facts checked', toolCalls: [] }; } });
  await env.executor.runTurn({ ...env.input, mode: 'goal', turnProfile: { role: 'work_session', workspaceId: 'workspace',
    context: { workSessionExecution: { phase: 'approved' } } }, plan: { delegationOrigin: { phase: 'running', readOnly: true } } });
  const system = env.requests[0].messages.filter((row: any) => row.role === 'system').map((row: any) => row.content).join('\n');
  expect(system).toContain('delegated task executor');
  expect(system).toContain('phase=running');
  expect(system).not.toContain('phase=approved');
  expect(env.requests[0].tools.some((tool: any) => tool.name === 'write_file')).toBe(false);
});

test('a parallel readonly batch reserves tool budget before any provider starts', async()=>{
  const env=harness({async stream(){return {content:'',toolCalls:['one','two','three'].map(id=>({id,name:'read_file',arguments:JSON.stringify({path:'README.md'})}))};}});
  writeFileSync(path.join(env.home,'README.md'),'real file');
  const outcome=await env.executor.runTurn({...env.input,hardRemainingToolCalls:1});
  expect(outcome.ok).toBe(false);expect(outcome.error).toBe('max_tool_calls_exceeded');
  expect(outcome.toolCalls).toHaveLength(0);
});

test('an event wake does not append an invented empty user message',async()=>{
  const env=harness({async stream(){return {content:'awake',toolCalls:[]};}});
  await env.executor.runTurn({...env.input,messages:[{role:'user',content:'earlier'},{role:'assistant',content:'previous reply'}]});
  expect(env.requests[0].messages.at(-1)).toMatchObject({role:'assistant',content:'previous reply'});
  expect(env.requests[0].messages.some((row:any)=>row.role==='user'&&row.content==='')).toBe(false);
});

test('a failed streamed reply persists only received text and marks the turn interrupted', async () => {
  const env=harness({async stream(request){request.onEvent?.({type:'text.delta',content:'received partial text'});throw new Error('test transport stopped');}});
  const outcome=await env.executor.runTurn({...env.input,ephemeral:false,assistantMessageId:'reply'});
  expect(outcome.ok).toBe(false);
  expect(env.persisted.at(-1)).toMatchObject({text:'received partial text',interrupted:true,calls:[]});
});

test('role routing uses the shared desktop model catalog and its capability flags', () => {
  const env = harness({async stream(){ return {content:'',toolCalls:[]}; }});
  writeFileSync(path.join(env.home, 'llm-providers.json'), JSON.stringify([
    {id:'text-model',groupId:'text-channel',provider:'openai',model:'text',enabled:true,isDefault:true,apiKeyConfigured:true,supportsTools:true,supportsVision:false},
    {id:'vision-model',groupId:'vision-channel',provider:'anthropic',model:'vision',enabled:true,apiKeyConfigured:true,supportsTools:true,supportsVision:true},
  ]));
  expect(env.executor.resolveGoalRole({role:'project_agent'})).toMatchObject({ok:true,selection:{modelProviderId:'text-model',modelId:'text'}});
  expect(env.executor.resolveGoalRole({role:'visual_verifier',taskRequiresVision:true})).toMatchObject({ok:true,selection:{modelProviderId:'vision-model',modelId:'vision'}});
});

test('successful project replies terminate the actual TUI pipeline with Grant and Evidence', async () => {
  for (const suppressed of [false, true]) {
    let posts = 0;
    const events: string[] = [];
    let projectProvider: ReturnType<typeof createProjectToolProvider>;
    const env = harness({ async stream() { return {
      content: '', toolCalls: [{ id: 'reply', name: 'post_reply',
        arguments: JSON.stringify({ text: 'connection ready', sources: [], replyTo: ['user-reply'] }) }],
    }; } }, { getProviders: () => [projectProvider] });
    projectProvider = createProjectToolProvider({ rootDir: env.home, supervisor: {}, objectives: {},
      replyComposer: { postReply() { posts++; return { ok: true, suppressed }; } },
      verification: {}, proactivity: {}, checkModel: () => ({ ok: true }), memoryEnabled: () => false });
    cleanup.push(() => projectProvider.dispose());
    for (let replay = 0; replay < 2; replay++) {
      const outcome = await env.executor.runTurn({ ...env.input, ephemeral: false, limits: { maxRounds: 2, maxToolCalls: 4 },
        sink: { send(channel) { events.push(channel); } } });
      expect(outcome.toolCalls[0]?.execution.result.status).toBe('success');
      expect(outcome.ok).toBe(true);
      expect(outcome.terminalStatus).toBe('completed');
      expect(outcome.requestedUserInput).toBeUndefined();
      expect(outcome.toolCalls).toHaveLength(1);
      expect(outcome.toolCalls[0].execution.grant.granted).toBe(true);
      expect(outcome.toolCalls[0].execution.result.status).toBe('success');
      expect(outcome.toolCalls[0].execution.result.evidence).toBeDefined();
      expect(env.persisted.at(-1).interrupted).toBe(false);
    }
    expect(env.requests).toHaveLength(2);
    expect(posts).toBe(1);
    expect(events.filter(channel => channel === 'chat:stream:done')).toHaveLength(2);
    expect(events).not.toContain('chat:stream:error');
    expect(events.indexOf('chat:stream:tool-result')).toBeLessThan(events.indexOf('chat:stream:done'));
  }
});

test('a failed project reply remains nonterminal in the TUI pipeline', async () => {
  let projectProvider: ReturnType<typeof createProjectToolProvider>;
  const env = harness({ async stream() { return { content: '', toolCalls: [{ id: 'reply', name: 'post_reply',
    arguments: JSON.stringify({ text: 'not verified', sources: [], replyTo: ['user-reply'] }) }] }; } },
  { getProviders: () => [projectProvider] });
  projectProvider = createProjectToolProvider({ rootDir: env.home, supervisor: {}, objectives: {},
    replyComposer: { postReply() { return { ok: false, error: 'verification_required' }; } },
    verification: {}, proactivity: {}, checkModel: () => ({ ok: true }), memoryEnabled: () => false });
  cleanup.push(() => projectProvider.dispose());
  const outcome = await env.executor.runTurn({ ...env.input, limits: { maxRounds: 2, maxToolCalls: 4 } });
  expect(outcome.ok).toBe(true);
  expect(outcome.turnEnd).toBe('yielded');
  expect(env.requests).toHaveLength(2);
  expect(outcome.toolCalls.every((call: any) => call.execution.result.outputPreview.control === undefined)).toBe(true);
});
