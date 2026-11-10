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
import { createTurnTestRuntime, drainTestCleanup, waitForTestStart, type TestCleanup } from './turn-test-support.ts';
import { spawn, spawnSync } from 'node:child_process';
import { resolveWorkSessionProfile } from '@peer-agent/runtime-node/project-agent';
import { createInterface } from 'node:readline';

const cleanups: TestCleanup[] = [];
afterEach(() => drainTestCleanup(cleanups));
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

test('terminal retention shares the real draft writer and releases compatibility on a busy source', async () => {
  const f = fixture();
  let releases = 0;
  const host = createTuiProjectHost({ ...f, autoStart: false,
    getSettings: () => ({ projectAgent: { interactiveResults: true } }),
    acquireInteractiveRetentionCompatibility: () => ({
      revision: `sha256:${'a'.repeat(64)}`, assertCurrent: () => true, release() { releases++; },
    }),
  });
  cleanups.push(() => host.close());
  host.leases.acquire(f.workspaceId);
  const reference = { owner: { workspaceId: f.workspaceId, conversationId: f.conversationId },
    resultId: 'missing-result', contentVersion: `sha256:${'b'.repeat(64)}` };
  const writer = host.drafts.acquireRetentionDrafts(f.workspaceId);
  try {
    expect(() => host.interactive.retention.preview(reference)).toThrow('DRAFT_BUSY');
    expect(releases).toBe(1);
  } finally { writer.release(); }
  mkdirSync(path.join(f.dataHome, 'goal-plans'), { recursive: true });
  expect(() => host.interactive.retention.preview(reference)).toThrow('interactive_result_unavailable');
  expect(releases).toBe(2);
});

test('a new TUI process recovers an uncommitted preparation from its prior host stop', async () => {
  const f = fixture();
  const host = createTuiProjectHost({ ...f, autoStart: false,
    getSettings: () => ({ projectAgent: { interactiveResults: true }, memory: { enabled: false } }),
    executeTurn: async () => { throw Error('recovery must not run cognition'); },
  });
  let closed = false;
  try {
    await host.tick();
    expect(host.holdsLease(f.workspaceId)).toBe(true);
    host.conversations.appendMessage(f.conversationId, { id: 'stop-anchor', role: 'user', kind: 'user_input', content: 'Stop this task' } as never);
    const history = host.conversations.getPersistedConversationHistory!(f.conversationId)!;
    const child = host.conversations.createChildConversation!({ parentConversationId: f.conversationId, role: 'work_session',
      anchorMessageId: 'stop-anchor', delegation: { sessionId: 'stopped-session', anchorMessageId: 'stop-anchor', inputId: 'stop-input' },
      capturedAt: new Date().toISOString(), runtimeState: { conversationId: f.conversationId, contentRevision: history.contentRevision, status: 'idle' },
      backgroundMessageIds: ['stop-anchor'], confirmMissing: true, title: 'Stopped worker', workspaceId: f.workspaceId } as never);
    const model = { modelProviderId: provider.id, providerId: provider.provider, modelId: provider.model, family: 'fixture' };
    const plan = host.plans.createPlan({ title: 'Stopped worker', conversationId: child.id, status: 'completed', tasks: [],
      delegationOrigin: { workspaceId: f.workspaceId, parentConversationId: f.conversationId, sessionId: 'stopped-session',
        phase: 'paused', readOnly: true, anchorMessageId: 'stop-anchor', inputId: 'stop-input',
        modelSelection: { worker: model, explorer: model, verifier: model, resolvedAt: new Date().toISOString() } } } as never);
    const control = host.supervisor.sessionControl;
    const operation = control.begin(plan, { kind: 'pause', operationId: 'pause-test', authorityRef: 'stop-input', priorStopReceiptId: undefined });
    const callRef = { owner: { workspaceId: f.workspaceId, conversationId: f.conversationId },
      conversationId: child.id, toolCallId: 'prepared-call' };
    host.interactive.resultStore.beginAttempt({ callRef, source: { ...operation.expectedExecution,
      conversationId: child.id, toolCallId: callRef.toolCallId },
      draft: { publication: { kind: 'create' }, title: 'Candidate', textFallback: 'Unverified', program: 'root=Text("test")', inputs: [] } }, () => true);
    const receipt = await control.drain(host.plans.getPlan(plan.planId), operation);
    control.settle(host.plans.getPlan(plan.planId), operation, receipt);
    expect(host.interactive.resultStore.getAttempt(callRef)?.phase).toBe('prepared');

    const helper = path.join(f.dataHome, 'recovery-child.ts');
    writeFileSync(helper, `
      import { createTuiProjectHost } from ${JSON.stringify(new URL('./tui-project-host.ts', import.meta.url).href)};
      const { f, callRef } = JSON.parse(process.argv[2]);
      let turns = 0;
      const host = createTuiProjectHost({ ...f, autoStart: false,
        getSettings: () => ({ projectAgent: { interactiveResults: true }, memory: { enabled: false } }),
        executeTurn: async () => { turns++; throw Error('recovery must not run cognition'); },
      });
      try {
        await host.tick();
        console.log('recovery-result ' + JSON.stringify({
          turns, held: host.holdsLease(f.workspaceId), attempt: host.interactive.resultStore.getAttempt(callRef),
          operation: host.interactive.resultStore.getOperation(callRef),
        }));
      } finally { await host.close(); }
    `);
    await host.close();
    closed = true;
    const processResult = spawnSync(process.execPath, [helper, JSON.stringify({ f, callRef })], { encoding: 'utf8', timeout: 12_000 });
    expect(processResult.status, processResult.error?.message || processResult.stderr).toBe(0);
    const line = processResult.stdout.split('\n').find(row => row.startsWith('recovery-result '));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice('recovery-result '.length))).toMatchObject({
      turns: 0, held: true, attempt: { phase: 'failed', code: 'publication_interrupted' }, operation: null,
    });
  } finally {
    if (!closed) await host.close();
  }
}, 18_000);

test('actual terminal project host returns fixed report references and attaches them to the canonical Bot reply', async () => {
  const f = fixture(), runtimeCleanup: TestCleanup[] = [];
  let host: ReturnType<typeof createTuiProjectHost>, fixed = '', rounds = 0;
  host = createTuiProjectHost({ ...f, autoStart: false,
    getSettings: () => ({ providers: [provider], projectAgent: { concurrency: 1, interactiveResults: true }, memory: { enabled: false } }),
    createRuntime(options) {
      const toolHost = createTuiHost(options);
      const model = createProviderChatModel({ model: 'test-model', toolDefinitionsForMode: mode => toolHost.toolDefinitionsForMode!(mode),
        getSystemPrompt: context => buildTuiSystemPrompt({}, { ...context.systemContextInput, mode: context.mode }),
        provider: { async stream(request) {
          rounds++;
          expect(request.tools?.some(tool => tool.name === 'publish_interactive_result')).toBe(false);
          const call = (name: string, args: object) => ({ content: '', toolCalls: [{ id: `fixed-main-${rounds}`, name, arguments: JSON.stringify(args) }] });
          if (rounds === 1) return call('get_session', { sessionId: 'fixed-session', detail: 'report' });
          // post_reply is terminal after a successful receipt. A third model
          // request would replay reasoning after the formal reply is settled.
          expect(rounds).toBe(2);
          const encoded = JSON.parse(String(request.messages.filter(row => row.role === 'tool').at(-1)?.content));
          const body = encoded.output ?? encoded;
          expect(body.ok).toBe(true); expect(body.report.evidenceRefs).toContain(fixed);
          expect(body.report.evidenceRefs).not.toContain('tool-result://fixed-publication');
          return call('post_reply', { text: 'The fixed trial is saved; the task remains incomplete and unverified.', replyTo: ['input-show-fixed-result'],
            sources: ['fixed-session'], statusClaims: [{ sessionId: 'fixed-session', status: body.status }] });
        } } });
      return createTurnTestRuntime({ host: toolHost, model, modelSelection: createTuiModelSelectionControl({ providerId: 'configured', modelId: 'test-model', displayName: 'test' }) }, runtimeCleanup);
    } });
  cleanups.push(() => drainTestCleanup(runtimeCleanup)); cleanups.push(() => host.close());
  host.leases.acquire(f.workspaceId);
  expect(host.holdsLease(f.workspaceId)).toBe(true);
  host.conversations.appendMessage(f.conversationId, { id: 'fixed-anchor', role: 'user', kind: 'user_input', content: 'Compare the fixed trial' } as never);
  const history = host.conversations.getPersistedConversationHistory!(f.conversationId);
  const child = host.conversations.createChildConversation!({ parentConversationId: f.conversationId, role: 'work_session', anchorMessageId: 'fixed-anchor',
    delegation: { sessionId: 'fixed-session', anchorMessageId: 'fixed-anchor', inputId: 'fixed-input' }, capturedAt: new Date().toISOString(),
    runtimeState: { conversationId: f.conversationId, contentRevision: history!.contentRevision, status: 'idle' }, backgroundMessageIds: ['fixed-anchor'], confirmMissing: true,
    title: 'Fixed worker', workspaceId: f.workspaceId } as never);
  const selection = { modelProviderId: 'configured', providerId: 'openai', modelId: 'test-model', family: 'fixture' };
  const plan = host.plans.createPlan({ title: 'Fixed trial', conversationId: child.id, status: 'executing',
    tasks: [{ taskId: 'trial', title: 'Fixed trial', status: 'pending' }, { taskId: 'remaining', title: 'Remaining analysis', status: 'pending' }],
    delegationOrigin: { workspaceId: f.workspaceId, parentConversationId: f.conversationId, sessionId: 'fixed-session', phase: 'running',
      anchorMessageId: 'fixed-anchor', inputId: 'fixed-input', modelSelection: { worker: selection, explorer: selection, verifier: selection, resolvedAt: new Date().toISOString() } } } as never);
  const published = await host.interactive.provider.executeCapability({ call: { toolCallId: 'fixed-publication', capabilityId: 'local.interactive.publish', arguments: {
    publication: { kind: 'create' }, title: 'Fixed terminal trial', textFallback: 'Unverified saved model trial.', program: 'root=Metric("Value",2)', inputs: [],
  } } }, { toolContext: { workspaceId: f.workspaceId, conversationId: child.id, turnProfile: resolveWorkSessionProfile({ plan, kind: 'worker' }) }, requestPermission: async () => ({ granted: true }) });
  expect(published!.result.status).toBe('success'); fixed = (published!.result.outputPreview as any).artifactRef;
  host.plans.recordEvidenceRefs({ evidenceRefs: ['tool-result://fixed-publication'], artifactRefs: [fixed], planId: plan.planId, conversationId: child.id,
    toolCallId: 'fixed-publication', capabilityId: 'local.interactive.publish', toolName: 'publish_interactive_result' } as never);
  host.plans.recordTaskEvidence(plan.planId, 'trial', { status: 'completed', result: 'Saved unverified trial.', evidenceRefs: ['tool-result://fixed-publication'] });
  host.plans.revisePlan(plan.planId, { status: 'failed', runner: { status: 'failed', error: 'Fixture task incomplete' },
    delegationOrigin: { ...host.plans.getPlan(plan.planId).delegationOrigin, phase: 'paused' } } as never);
  const executable = process.env.PEER_TEST_STANDALONE_BINARY;
  const command = executable ? [executable] : [process.execPath, path.join(import.meta.dir, '../index.tsx')];
  const prompt = 'Show the saved fixed trial and its current task status';
  const run = (id: string, text: string, waitMs = 5000) => {
    const child = Bun.spawn([...command, 'exec', '--bot', '--input-id', id, '--wait-ms', String(waitMs), '--output-format', 'json', text],
      { cwd: f.workspacePath, env: { ...process.env, PEER_AGENT_HOME: f.dataHome }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    cleanups.push(() => { if (child.exitCode === null) child.kill(); });
    return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  };
  const cli = run('show-fixed-result', prompt);
  for (let attempt = 0; attempt < 80 && !host.inputs.findSubmission(f.workspaceId, 'show-fixed-result'); attempt++) await Bun.sleep(25);
  expect(host.inputs.findSubmission(f.workspaceId, 'show-fixed-result')?.text).toBe(prompt);
  await host.tick();
  const [exit, stdout, stderr] = await cli;
  expect(exit, stderr + stdout).toBe(0);
  const delivered = JSON.parse(stdout);
  expect(delivered).toMatchObject({ ok: true, botInput: { inputId: 'show-fixed-result', status: 'replied' },
    interactiveResults: [{ ref: fixed, availability: 'available', textFallback: 'Unverified saved model trial.' }] });
  expect(host.holdsLease(f.workspaceId)).toBe(true);
  const [retryExit, retryOut] = await run('show-fixed-result', prompt);
  expect(retryExit).toBe(0);
  expect(JSON.parse(retryOut).botInput).toEqual(delivered.botInput);
  const [conflictExit, conflictOut] = await run('show-fixed-result', 'A different prompt');
  expect(conflictExit).toBe(1);
  expect(JSON.parse(conflictOut).error).toBe('bot_input_conflict');
  const [pendingExit, pendingOut] = await run('later', 'Another queued request', 30);
  expect(pendingExit).toBe(8);
  expect(JSON.parse(pendingOut)).toMatchObject({ ok: false, error: 'bot_reply_pending', botInput: { inputId: 'later', status: 'received' } });
  const messages = host.conversations.getPersistedConversationHistory!(f.conversationId)!.messages;
  const post = messages.flatMap((row: any) => row.rounds ?? []).flatMap((round: any) => round.toolCalls ?? []).find((call: any) => call.name === 'post_reply');
  expect((post as any)?.result?.ok, JSON.stringify((post as any)?.result)).toBe(true);
  expect((post as any)?.result?.meta?.evidenceRefs).toEqual([fixed]);
  const reply = messages.filter((row: any) => row.kind === 'agent_reply').at(-1);
  expect(reply).toBeDefined();
  expect(rounds).toBe(2); expect((reply as any).meta.evidenceRefs).toEqual([fixed]);
  expect((host.supervisor.get({ sessionId: 'fixed-session', detail: 'report' }) as any).report.evidenceRefs).toEqual([fixed]);
  expect((reply as any).marks.some((mark: any) => mark.outcome === 'passed')).toBe(false);
});

test('terminal plan approval is durable before admission and replays only an awaiting plan', async () => {
  const f = fixture(), host = start(f, async () => ({ ok: true, text: 'ready' }));
  await host.tick();
  let resumed = 0;
  (host.supervisor as any).get = () => ({ origin: { phase: 'awaiting_approval' } });
  (host.supervisor as any).resumeFromApproval = async (record: any) => {
    expect(host.approvals.list({ workspaceId: f.workspaceId }).find((row: any) => row.approvalId === record.approvalId)?.state).toBe('approved');
    expect(record.decidedBy).toBe('local_ui');
    expect(Number.isFinite(Date.parse(record.decidedAt))).toBe(true);
    resumed++; return { ok: true };
  };
  host.approvals.append({ approvalId: 'plan:s', workspaceId: f.workspaceId, sessionId: 's', planId: 'p',
    conversationId: 'c', capabilityId: 'goal.plan', kind: 'plan_approval', state: 'open', argsDigest: 'a'.repeat(64) } as never);
  expect((await host.decideApproval('plan:s', 'approve')).ok).toBe(true);
  expect(resumed).toBe(1);
  expect((await host.decideApproval('plan:s', 'approve')).ok).toBe(true);
  expect(resumed).toBe(2);
  expect((await host.decideApproval('plan:s', 'deny')).ok).toBe(true);
  expect(resumed).toBe(2);
  (host.supervisor as any).get = () => ({ origin: { phase: 'superseded' } });
  expect((await host.decideApproval('plan:s', 'approve')).ok).toBe(true);
  expect(resumed).toBe(2);
});

test('terminal never admits a plan if persisting approval fails', async () => {
  const f = fixture(), host = start(f, async () => ({ ok: true, text: 'ready' }));
  await host.tick();
  let resumed = 0;
  (host.supervisor as any).get = () => null;
  (host.supervisor as any).resumeFromApproval = async () => { resumed++; return { ok: true }; };
  host.approvals.append({ approvalId: 'plan:s', workspaceId: f.workspaceId, sessionId: 's', planId: 'p', state: 'open', capabilityId: 'goal.plan' });
  (host.approvals as any).append = () => { throw Error('disk failure'); };
  await expect(host.decideApproval('plan:s', 'approve')).rejects.toThrow('disk failure');
  expect(resumed).toBe(0);
});

test('terminal task scheduling stays closed until recovery and after host drain', async () => {
  const f = fixture(), host = start(f, async () => ({ ok: true, text: 'ready' }));
  const scheduler = host.executor.executionScheduler;
  expect(scheduler.isWorkspaceReady(f.workspaceId)).toBe(false);
  expect(scheduler.isWorkspaceReady('another-workspace')).toBe(false);
  await host.tick();
  expect(scheduler.isWorkspaceReady(f.workspaceId)).toBe(true);
  host.host.drain(f.workspaceId);
  expect(scheduler.isWorkspaceReady(f.workspaceId)).toBe(false);
});

test('closing a terminal host blocks new input while its old turn drains', async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const host = start(f, async () => { calls++; entered(); await gate; return { ok: true, text: 'done' }; });
  host.inputs.submitInput({ workspaceId: f.workspaceId, inputId: 'before-close', surface: 'tui', text: 'first' });
  const first = host.tick();
  let closing: Promise<unknown> | undefined, late: Promise<unknown> | undefined;
  try {
    await waitForTestStart(started, first, 'terminal host turn');
    closing = host.close();
    host.inputs.submitInput({ workspaceId: f.workspaceId, inputId: 'during-close', surface: 'tui', text: 'second' });
    late = host.tick();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls).toBe(1);
    expect(host.holdsLease(f.workspaceId)).toBe(false);
  } finally {
    release();
    await Promise.allSettled([first, closing, late]);
  }
});

test('terminal composition consumes a durable input once and projects its shared reply', async () => {
  const f = fixture(), calls: any[] = [];
  const host = start(f, async input => { calls.push(input); return { ok: true, toolCalls: [{ name: 'post_reply', input: { text: 'received', replyTo: ['input-same-input'] }, result: { ok: true } }] }; });
  const client = createTuiProjectClient({ dataHome: f.dataHome, host, autoStart: false });
  cleanups.push(() => client.close());
  const receipt = client.submit('hello', { inputId: 'same-input' });
  expect(receipt.inputId).toBe('same-input');
  await host.tick();
  client.submit('different retry text', { inputId: 'same-input' }); await host.tick();
  const messages = (await client.poll(true)).messages;
  expect(calls).toHaveLength(1);
  expect(messages.filter(row => row.id === 'input-same-input')).toHaveLength(1);
  expect(messages.find(row => row.id === 'input-same-input').content).toBe('hello');
  expect(messages.find(row => row.kind === 'agent_reply').content).toBe('received');
  expect(calls[0].turnProfile.role).toBe('project_agent');
  expect(calls[0].turnProfile.modelSelection.modelProviderId).toBe('configured');
});

test('terminal model context keeps legacy public interactions and excludes private process records', async () => {
  const f=fixture(), requests:(readonly any[])[]=[];
  const runtimeCleanup: TestCleanup[] = [];
  const host=createTuiProjectHost({...f,autoStart:false,
    getSettings:()=>({providers:[provider],projectAgent:{concurrency:1},memory:{enabled:false}}),
    createRuntime(options){
      const toolHost=createTuiHost(options);
      return createTurnTestRuntime({host:toolHost,
        modelSelection:createTuiModelSelectionControl({providerId:'configured',modelId:'test-model',displayName:'test'}),
        model:createProviderChatModel({model:'test-model',toolDefinitionsForMode:mode=>toolHost.toolDefinitionsForMode!(mode),
          getSystemPrompt:context=>buildTuiSystemPrompt({}, {...context.systemContextInput,mode:context.mode}),
          provider:{async stream(request){requests.push(request.messages);return {content:'Public reply',toolCalls:[]};}}}),
      }, runtimeCleanup);
    }});
  cleanups.push(()=>drainTestCleanup(runtimeCleanup));
  cleanups.push(()=>host.close());
  host.conversations.appendMessage(f.conversationId,{id:'legacy-public-user',role:'user',content:'KEEP_LEGACY_USER_BOUNDARY'});
  host.conversations.appendMessage(f.conversationId,{id:'legacy-public-assistant',role:'assistant',content:'KEEP_LEGACY_PUBLIC_REPLY'});
  host.conversations.appendMessage(f.conversationId,{id:'private-process-record',role:'assistant',kind:'agent_turn',turnKind:'wake',
    content:'PRIVATE_PROCESS_SENTINEL',rounds:[{content:'PRIVATE_ROUND_SENTINEL'}]} as never);
  host.inputs.submitInput({workspaceId:f.workspaceId,inputId:'current-public-input',surface:'tui',text:'Current public question'});
  await host.tick();
  const messages=requests.flat();
  expect(messages.some(row=>row.role==='user'&&JSON.stringify(row.content).includes('KEEP_LEGACY_USER_BOUNDARY'))).toBe(true);
  expect(messages.some(row=>row.role==='assistant'&&JSON.stringify(row.content).includes('KEEP_LEGACY_PUBLIC_REPLY'))).toBe(true);
  expect(JSON.stringify(requests)).not.toContain('PRIVATE_PROCESS_SENTINEL');
  expect(JSON.stringify(requests)).not.toContain('PRIVATE_ROUND_SENTINEL');
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
  expect((await client.poll(true)).isHost).toBe(false);
  expect((await client.poll()).messages.some(row => row.id === 'input-other-process')).toBe(false);
  expect(await client.decide('approval', 'approve')).toEqual({ ok: false, error: 'desktop_approval_required' });
  desktop.close(); await host.tick();
  expect(turns).toBe(1);
});

test('unchanged client polls retain snapshot identity and read only public pages and current cards', async () => {
  const f = fixture(), host = start(f, async () => ({ ok: true, text: 'hello' }));
  const client = createTuiProjectClient({ dataHome: f.dataHome, host, autoStart: false });
  cleanups.push(() => client.close());
  const original = host.directory.readConversation;
  host.directory.readConversation = ((workspaceId: string, params: any) => {
    expect(params.view).toBe('cards');
    return original(workspaceId, params);
  }) as typeof original;
  const first = await client.poll();
  expect(await client.poll()).toBe(first);
  host.directory.readConversation = original;
});

test('a client input is consumed once by a host in a different process',async()=>{
  const f=fixture(), helper=path.join(f.dataHome,'host-child.ts');
  writeFileSync(helper,`import {createInterface} from 'node:readline';
import {createTuiProjectHost} from ${JSON.stringify(new URL('./tui-project-host.ts',import.meta.url).href)};
const host=createTuiProjectHost({dataHome:process.argv[2],workspacePath:process.argv[3],autoStart:false,
  getSettings:()=>({providers:[${JSON.stringify(provider)}],memory:{enabled:false}}),
  executeTurn:async()=>({ok:true,toolCalls:[{name:'post_reply',input:{text:'child process received',replyTo:['input-cross-process']},result:{ok:true}}]})});
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
  client.submit('cross process',{inputId:'cross-process'});expect((await client.poll(true)).isHost).toBe(false);
  child.stdin.write('tick\n');await next('child-consumed');
  expect((await client.poll(true)).messages.filter(row=>row.kind==='agent_reply'&&row.content==='child process received')).toHaveLength(1);
  client.submit('duplicate retry',{inputId:'cross-process'});child.stdin.write('tick\n');await next('child-consumed');
  expect((await client.poll(true)).messages.filter(row=>row.id==='input-cross-process')).toHaveLength(1);
  expect((await client.poll(true)).messages.filter(row=>row.kind==='agent_reply'&&row.content==='child process received')).toHaveLength(1);
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
  const previousDataHome=process.env.PEER_AGENT_HOME;process.env.PEER_AGENT_HOME=f.dataHome;
  cleanups.push(()=>{if(previousDataHome===undefined)delete process.env.PEER_AGENT_HOME;else process.env.PEER_AGENT_HOME=previousDataHome;});
  const runtimeCleanup: TestCleanup[] = [];
  let host:ReturnType<typeof createTuiProjectHost>;
  let sequence=0, verified=false, rootReviews=0;
  let disposition:'wait'|'return'='wait', currentInputs:string[]=[];
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
            if(content.includes('host-bound root goal review')){
              rootReviews++;
              expect(content).toContain('Read README and verify it');
              expect(content).toContain('canonicalInputs');
            }
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
            if(lastTool?.name==='post_reply')return {content:'',toolCalls:[]};
            if(lastTool?.name==='coordinate_work'){
              const encoded=JSON.parse(lastTool.content),result=encoded.output ?? encoded;
              expect(result.ok).toBe(true);
              if(result.decisionFrame){
                const ready=verified&&session.status==='result_ready';
                disposition=ready?'return':'wait'; currentInputs=result.sourceInputIds;
                const row=result.decisionFrame.sessions.find((row:any)=>row.sessionId===session.sessionId);
                const refs=host.plans.listEvidenceIndex().filter((row:any)=>row.planId===plan?.planId&&row.bodyPreview?.text?.includes('verified terminal fixture')).map((row:any)=>row.evidenceRef);
                return call('coordinate_work',{action:'assess',reason:'Record the original README responsibility',assessment:{
                  workId:result.workId,expectedWorkRevision:result.workRevision,expectedGoalRevision:result.goalRevision,
                  sourceInputIds:result.sourceInputIds,sourceEventIds:result.sourceEventIds,sourceDecisionRef:result.sourceDecisionRef,
                  inputs:result.sourceInputIds.map((inputId:string)=>({inputId,kind:'delegate',reason:'Read and verify the README'})),
                  ...(!result.intent?{interpretation:{outcome:'Read README and verify it',constraints:[],nonGoals:[],openQuestions:[],
                    requirements:[{requirementId:'readme',text:'README exists and its contents are verified',sourceInputIds:['chain']}]}}:{}),
                  coverage:[{requirementId:'readme',status:ready?'covered':'remaining',explanation:ready?'The real file evidence was independently verified':'The delegated read is still in progress',
                    sources:ready?[{sessionId:session.sessionId,sourceRevision:row.sourceRevision,evidenceRefs:refs}]:[]}],
                  disposition:ready?{kind:'return',replyRef:result.currentReplyRef}:{kind:'wait',waitFor:[{kind:'session',id:session.sessionId,revision:row.observationRevision||row.sourceRevision}]},
                  reason:ready?'Return the verified original result':'Wait for the actual delegated result',
                }});
              }
              if(disposition==='return'){
                expect(result.review?.passed).toBe(true);
                return call('post_reply',{text:'已完成 README 检查并通过验收。',sources:[session.sessionId],replyTo:currentInputs.length?['input-chain']:[],proactive:!currentInputs.length,statusClaims:[{sessionId:session.sessionId,status:session.status}]});
              }
              if(currentInputs.length)return call('post_reply',{text:'已开始检查 README。',sources:[session.sessionId],replyTo:['input-chain'],statusClaims:[{sessionId:session.sessionId,status:session.status}]});
              return {content:'',toolCalls:[]};
            }
            return call('coordinate_work',{action:'query',workId:session.origin!.workId,reason:'Read the current goal and source versions'});
          }
          if(!lastTool)return call('read_file',{path:'README.md'});
          if(lastTool.name==='read_file')return call('goal_update_task',{planId:plan!.planId,taskId:plan!.tasks[0].taskId,status:'completed',result:'README read',evidenceRefs:[`tool-result://${lastTool.toolCallId}`],criterionResults:[{criterionId:'c1',passed:true,evidenceRef:`tool-result://${lastTool.toolCallId}`,detail:'Real read confirms README exists'}]});
          return {content:'worker finished',toolCalls:[]};
        }}});
      return createTurnTestRuntime({host:toolHost,model,modelSelection:createTuiModelSelectionControl({providerId:'configured',modelId:'test-model',displayName:'test'})}, runtimeCleanup);
    }});
  cleanups.push(()=>drainTestCleanup(runtimeCleanup));
  cleanups.push(()=>host.close());
  const client=createTuiProjectClient({dataHome:f.dataHome,host,autoStart:false});cleanups.push(()=>client.close());
  client.submit('Read README and verify it',{inputId:'chain'});await host.tick();
  const deadline=Date.now()+6000;
  while(Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));await host.tick();
    if((await client.poll(true)).messages.some(row=>row.kind==='agent_reply'&&row.content.includes('通过验收'))
      &&host.supervisor.coordinationFacts(f.workspaceId,f.conversationId,null).some((row:any)=>row.lifecycle==='fulfilled'))break;}
  const snapshot=await client.poll(true),session=snapshot.sessions[0];
  expect(session).toBeDefined();
  expect(snapshot.messages.some(row=>row.kind==='agent_reply'&&row.content.includes('通过验收'))).toBe(true);
  const plan=host.plans.getPlan(session.planId)!;
  expect(plan.hostVerification?.independentVerifier).toBe('passed');
  expect(rootReviews).toBe(1);
  expect(host.supervisor.coordinationFacts(f.workspaceId,f.conversationId,null).some((row:any)=>row.lifecycle==='fulfilled')).toBe(true);
  expect(host.plans.listEvidenceIndex().some((row:any)=>row.planId===plan.planId&&row.bodyPreview?.text==='verified terminal fixture')).toBe(true);
  const before=JSON.parse(JSON.stringify({status:plan.status,runner:plan.runner,origin:plan.delegationOrigin}));
  await host.close();
  const after=host.plans.getPlan(plan.planId)!;
  expect({status:after.status,runner:after.runner,origin:after.delegationOrigin}).toEqual(before);
},15000);

test('terminal public messages survive optional card failure and a failed refresh without a full conversation read',async()=>{
  const f=fixture(),host=start(f,async()=>({ok:true,toolCalls:[{name:'post_reply',input:{text:'public reply',replyTo:['input-isolated-public']},result:{ok:true}}]}));
  const client=createTuiProjectClient({dataHome:f.dataHome,host,autoStart:false});cleanups.push(()=>client.close());
  client.submit('public question',{inputId:'isolated-public'});await host.tick();
  const before=await client.poll(true);expect(before.messages.some(row=>row.content==='public reply')).toBe(true);
  const read=host.directory.readConversation,interactions=host.directory.readInteractions;
  try {
    host.directory.readConversation=((_workspaceId: string,params: any)=>{
      expect(params.view).toBe('cards');return {ok:false,code:'CONTROLLED_CARD_FAILURE'};
    }) as typeof read;
    const cardsFailed=await client.poll(true);expect(cardsFailed.cardsUnavailable).toBe(true);
    expect(cardsFailed.messages.some(row=>row.content==='public reply')).toBe(true);
    host.directory.readInteractions=(async()=>{throw new Error('CONTROLLED_PUBLIC_FAILURE');}) as typeof interactions;
    const refreshFailed=await client.poll(true);expect(refreshFailed.messageState).toBe('unavailable');
    expect(refreshFailed.messages).toEqual(cardsFailed.messages);
  }finally{host.directory.readConversation=read;host.directory.readInteractions=interactions;}
});


test('terminal cancellation keeps its own durable state and cannot replay as an approval', async () => {
  const f = fixture(), host = start(f, async () => ({ ok: true, text: 'ready' })); await host.tick();
  let resumed = 0; (host.supervisor as any).resumeFromApproval = async () => { resumed++; return { ok: true }; };
  host.approvals.append({ approvalId: 'image-cancel', workspaceId: f.workspaceId, sessionId: 's', state: 'stale', capabilityId: 'local.image.read' });
  const cancelled = await host.decideApproval('image-cancel', 'cancel');
  expect(cancelled.ok).toBe(true); expect((cancelled as any).approval.state).toBe('cancelled');
  expect((cancelled as any).approval.decisionReason).toBe('permission_cancelled');
  const replay = await host.decideApproval('image-cancel', 'approve');
  expect((replay as any).approval.state).toBe('cancelled'); expect(resumed).toBe(0);
});

test('terminal client coalesces bounded reads and drops a late result after close', async () => {
  const f = fixture(), host = start(f, async () => ({ ok: true, text: 'ready' }));
  let complete!: (value: any) => void, reads = 0, published = 0;
  (host.directory as any).readInteractions = async (_id: string, params: any) => {
    reads++; expect(params.limit).toBe(50);
    return await new Promise(resolve => { complete = resolve; });
  };
  const client = createTuiProjectClient({ dataHome: f.dataHome, host, autoStart: false, onChanged: () => { published++; } });
  const first = client.poll(), second = client.poll(true);
  expect(reads).toBe(1);
  await client.close();
  complete({ ok: true, messages: [{ id: 'late', kind: 'agent_reply', content: 'late' }], nextCursor: null });
  await Promise.all([first, second]);
  expect(published).toBe(0); expect(client.current().messages).toEqual([]);
});
test('terminal mode close saves drafts and refuses to detach when saving fails', async () => {
  const f = fixture(), host = start(f, async () => ({ ok: true, text: 'ready' }));
  const client = createTuiProjectClient({ dataHome: f.dataHome, host, autoStart: false });
  const session = client.recovery(f.workspaceId); await session.load();
  const get = host.directory.get;
  (host.directory as any).get = () => ({ ok: false });
  session.edit({ text: 'preserve on switch' });
  await expect(client.close()).rejects.toThrow('project_draft_save_failed');
  (host.directory as any).get = get;
  await client.close();
  const reopened = createTuiProjectClient({ dataHome: f.dataHome, host, autoStart: false });
  cleanups.push(() => reopened.close());
  const recovered = reopened.recovery(f.workspaceId); await recovered.load();
  expect(recovered.getSnapshot().draft.text).toBe('preserve on switch');
  expect(() => client.submit('after close')).toThrow('project_client_closed');
});
