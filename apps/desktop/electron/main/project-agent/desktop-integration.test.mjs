import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(os.tmpdir(), 'peer-beta-integration-'));
const previousHome = process.env.PEER_AGENT_HOME;
process.env.PEER_AGENT_HOME = root;
const { createConversationStore } = await import('@peer-agent/conversation-store');
const { createGoalPlanStore, createMemoryStore, resolveRoleRoute } = await import('@peer-agent/runtime-node');
const { registerDesktopProjectAgent } = await import('./project-agent-host.mjs');
const { projectTurnSystemContext } = await import('../llm-chat-service.mjs');
const { createAgentTurnExecutor } = await import('../agent-host/agent-turn-executor.mjs');
const { executeProjectedModelTool } = await import('../chat-runtime/projected-tool-executor.mjs');
const { createRuntimeToolProjection } = await import('../tools/index.mjs');
const { createProjectRosterPromptSource } = await import('../../../../../packages/system-context/src/sources/project-roster-source.mjs');
const provider = { id: 'configured', provider: 'openai', model: 'test-model', enabled: true,
  apiKeyConfigured: true, supportsVision: false, supportsTools: true, supportsStructured: true, isDefault: true };
after(() => { if (previousHome === undefined) delete process.env.PEER_AGENT_HOME; else process.env.PEER_AGENT_HOME = previousHome; rmSync(root, { recursive: true, force: true }); });

function harness({ blank = false, send = null, folder = null, dataHome = null, configured = true, verify = null, settings = {}, holdsLease = () => true } = {}) {
  const home = dataHome || mkdtempSync(path.join(root, 'home-'));
  const project = folder || path.join(home, 'workspace');
  mkdirSync(project, { recursive: true });
  if (!blank) writeFileSync(path.join(project, 'README.md'), 'test project');
  const conversations = createConversationStore({ storeDir: path.join(home, 'conversations') });
  const plans = createGoalPlanStore({ storeDir: path.join(home, 'goal-plans') });
  const calls = []; const routes = []; const starts = []; const events = [];
  let api;
  const executor = createAgentTurnExecutor({ llmChatService: {
    resolveGoalRole(input) { routes.push(input); return resolveRoleRoute({ ...input, providers: configured ? [provider] : [] }); },
    async sendMessage(input) { calls.push(input); return send ? send(input, { plans, conversations, api }) : { terminalStatus: 'done', text: 'hello' }; },
  } });
  const registrations = registerDesktopProjectAgent({ enabled: () => true, dataHome: home,
    conversationStore: conversations, goalPlanStore: plans, goalRunner: { async start(id) { starts.push(id); }, pause() {}, setOnPlanTerminal() {},
      ...(verify ? {verifyDelegatedSession:verify} : {}) },
    agentTurnExecutor: executor, workspace: { removeWorkspace() {} }, broadcast: (...args) => events.push(args),
    holdsLease, getSettings: () => ({ ...settings, workspaces: [{ path: project, name: 'test' }] }), mergeSettings() {},
    listModels: () => configured ? [provider] : [], dialog: {}, BrowserWindow: { getAllWindows: () => [] }, shell: {}, onReady(value) { api = value; },
  });
  const handlers = new Map();
  for (const registration of registrations) registration.register({ handle(channel, fn) { handlers.set(channel, fn); } });
  const bot = api.listItems()[0];
  const invoke = (channel, payload = {}) => handlers.get(`project-agent:${channel}`)({}, { workspaceId: bot.workspaceId, ...payload });
  return { executor, home, project, api, bot, plans, conversations, calls, routes, starts, events, invoke,
    history: () => conversations.getPersistedConversationHistory(bot.profile.agentConversationId).messages,
    async submit(inputId = crypto.randomUUID(), text = 'hello') {
      api.host.inputQueue.submitInput({ workspaceId: bot.workspaceId, inputId, text, surface: 'desktop' });
      await api.host.sync([bot.workspaceId]);
    }, dispose: () => api.dispose() };
}

async function tool(env, name, args, ordinal = 1) {
  const { registry, projection } = createRuntimeToolProjection({ projectionOptions: { mode: 'project_agent' } });
  return executeProjectedModelTool({ name, args, workspacePath: env.project,
    toolContext: { mode: 'project_agent', turnRole: 'project_agent', workspaceId: env.bot.workspaceId,
      conversationId: env.bot.profile.agentConversationId, turnId: env.turnId || `test-${crypto.randomUUID()}`, toolCallOrdinal: ordinal,
      currentInputAnchors: env.currentInputAnchors || [], messages: env.history(), readFiles: new Map() }, registry, runtimeProjection: projection, goalPlanStore: env.plans,
    toolCallId: crypto.randomUUID(), requestPermission: async () => { throw new Error('agent must not ask for approval'); },
  });
}

test('familiarize completion wakes, verifies, requires sources, persists acceptance and reversible memory', async () => {
  let env, sessionId, report = false;
  env = harness({verify:async()=>({passed:true,evidenceRefs:['ev-file'],verifierModel:provider.id}),send:async input=>{
    if (!report) return {terminalStatus:'done',text:'ready'};
    assert.ok(input.turnProfile.context.events.some(event=>event.kind==='result_ready'));
    const verified=await tool({...env,turnId:input.streamId},'verify_session',{sessionId});
    assert.equal(JSON.parse(verified.output).ok,true,verified.output);
    const args={text:'README describes a test project.',replyTo:[`lifecycle-research-${env.bot.workspaceId}`]};
    const missing=await tool({...env,turnId:input.streamId},'post_reply',args,2);
    assert.equal(JSON.parse(missing.output).error,'result_source_required');
    const cited={...args,sources:[sessionId],statusClaims:[{sessionId,status:env.api.supervisor.get({sessionId}).status}]};
    const result=await tool({...env,turnId:input.streamId},'post_reply',cited,3);
    assert.equal(JSON.parse(result.output).ok,true,result.output);
    input.webContents.send('chat:stream:tool-call',{toolCallId:'r',tool:'post_reply',args:cited});
    input.webContents.send('chat:stream:tool-result',{toolCallId:'r',result:JSON.parse(result.output)});
    return {terminalStatus:'done'};
  }});
  try {
    const opened=await env.invoke('start-familiarize');sessionId=opened.profile.familiarize.sessionId;
    const planId=env.api.supervisor.get({sessionId}).planId;
    env.plans.recordEvidenceRefs({planId,evidenceRef:'ev-file',toolName:'read_file',capabilityId:'local.file.read',
      bodyPreview:{kind:'file',text:'test project',truncated:false}});
    env.plans.revisePlan(planId,{tasks:[{taskId:'read',title:'Read',status:'completed',evidenceRefs:['ev-file']}]},{reason:'read complete',changedBy:'test'});
    env.plans.recordManualConfirmation(planId,{decision:'approve',criterionIds:['c1','c2'],decidedBy:'user'});
    env.plans.setPlanStatus(planId,'completed');report=true;
    await env.api.host.sync([env.bot.workspaceId]);
    assert.equal(env.plans.getPlan(planId).resultAcceptance?.acceptedBy,'policy',JSON.stringify(env.history().filter(item=>item.card)));
    const reply=env.history().find(message=>message.content==='README describes a test project.');
    assert.deepEqual(reply.meta.sessionStates,[{sessionId,status:'accepted'}]);
    const store=createMemoryStore({rootDir:env.home});
    const item=store.list({workspaceId:env.bot.workspaceId}).find(item=>item.trust==='verified');
    assert.ok(item);assert.deepEqual(reply.meta.memoryLearned,[item.id]);
    assert.equal((await env.invoke('read-evidence',{evidenceRef:'ev-file'})).summary,'test project');
    assert.equal(store.forget({id:item.id,workspaceId:env.bot.workspaceId,reason:'acceptance replay'}).ok,true);
    assert.equal(store.list({workspaceId:env.bot.workspaceId,status:'active'}).some(row=>row.id===item.id),false);
    assert.equal(store.restore({id:item.id,workspaceId:env.bot.workspaceId}).ok,true);
    assert.equal(store.list({workspaceId:env.bot.workspaceId,status:'active'}).some(row=>row.id===item.id),true);
  } finally {env.dispose();}
});

test('desktop registration routes real inputs and includes history, roster and wake facts at L7', async () => {
  const env = harness();
  try {
    await env.submit('first', 'first message'); await env.submit('second', 'second message');
    assert.equal(env.calls.length, 2);
    assert.equal(env.calls[0].turnProfile.modelSelection.modelProviderId, provider.id);
    assert.equal(env.calls[0].ephemeral, true);
    assert.ok(env.calls[1].messages.some(message => message.role === 'user' && message.content === 'first message'));
    assert.ok(env.calls[1].messages.some(message => message.role === 'assistant' && message.content === 'hello'));
    assert.ok(!env.calls[1].messages.some(message => message.kind === 'agent_turn'));
    env.api.host.inbox.append(env.bot.workspaceId, [{ eventId: 'verified', kind: 'session_verified', sessionId: 's1', at: new Date().toISOString() }]);
    await env.api.host.sync([env.bot.workspaceId]);
    const wake = env.calls.at(-1);
    assert.equal(wake.plan.kind, 'wake');
    assert.equal(wake.runtimeReminders[0].layer, 'L6_MODE_REMINDER');
    const source = createProjectRosterPromptSource();
    const observation = source.observe(projectTurnSystemContext(wake.turnProfile, { readMemory: () => [] }));
    assert.ok(observation.events.some(event => event.sessionId === 's1'));
    assert.match(source.render(observation)[0].content, /s1/);
  } finally { env.dispose(); }
});

test('the default LocalToolHost dispatches through supervisor, Grant and Evidence; sources are project scoped', async () => {
  const env = harness();
  try {
    await env.submit('anchor', 'read project');
    const opened = await tool(env, 'spawn_session', { anchorMessageIds: ['input-anchor'], title: 'Read', brief: 'Read files', kind: 'research', readOnly: true, successCriteria: ['Read'] });
    assert.equal(opened.success, true, JSON.stringify(opened));
    assert.equal(opened.execution.grant.granted, true); assert.equal(opened.execution.result.status, 'success');
    const output = JSON.parse(opened.output);
    assert.ok(output.sessionId); assert.equal(env.plans.listPlans().length, 1);
    assert.equal(env.starts.length, 1);
    const plan = env.plans.getPlan(env.starts[0]);
    assert.equal(plan.delegationOrigin.readOnly, true);
    assert.equal(plan.delegationOrigin.modelSelection.worker.modelProviderId, provider.id);
    assert.equal(plan.delegationOrigin.modelSelection.visualVerifier, undefined);
    const posted = await tool(env, 'post_reply', { text: 'Started', replyTo: ['input-anchor'], sources: [output.sessionId], statusClaims: [{sessionId:output.sessionId,status:env.api.supervisor.get({sessionId:output.sessionId}).status}] }, 2);
    assert.equal(posted.success, true, JSON.stringify(posted));
    assert.equal(JSON.parse(posted.output).message.content, 'Started');
    const forged = await tool(env, 'post_reply', { text: 'Fake', replyTo: ['input-anchor'], sources: ['other-project'] }, 3);
    assert.equal(forged.success, false); assert.equal(JSON.parse(forged.output).error, 'forged_sources');
    const foreign = await tool(env, 'get_session', { sessionId: output.sessionId });
    assert.equal(foreign.success, true);
    // The provider rejects foreign workspace ids before it calls the supervisor.
    const foreignProject = { ...env, bot: { ...env.bot, workspaceId: 'foreign' } };
    assert.equal(JSON.parse((await tool(foreignProject, 'get_session', { sessionId: output.sessionId })).output).error, 'out_of_scope');
  } finally { env.dispose(); }
});

test('familiarize creates one readonly session even on repeated clicks', async () => {
  const env = harness();
  try {
    const [a, b] = await Promise.all([env.invoke('start-familiarize'), env.invoke('start-familiarize')]);
    assert.equal(a.ok, true); assert.equal(b.ok, true); assert.equal(env.plans.listPlans().length, 1);
    const result = await env.invoke('start-familiarize'); assert.equal(result.reused, true);
    const plan = env.plans.getPlan(env.starts[0]); assert.equal(plan.delegationOrigin.readOnly, true);
    assert.ok(env.history().some(message => message.id === `lifecycle-research-${env.bot.workspaceId}`));
  } finally { env.dispose(); }
});

test('missing routes fail before creating a familiarize session or marking its profile started', async () => {
  const env = harness({ configured: false });
  try {
    const result = await env.invoke('start-familiarize');
    assert.equal(result.ok, false); assert.equal(result.code, 'model_unavailable');
    assert.equal(env.plans.listPlans().length, 0);
    assert.equal((await env.invoke('get')).profile.familiarize, null);
    assert.ok(env.history().some(message => message.role === 'user' && message.id.startsWith('lifecycle-research-')));
  } finally { env.dispose(); }
});

test('blank project responsibility uses the persisted input and README acceptance spawns once', async () => {
  const env = harness({ blank: true });
  try {
    assert.equal((await env.invoke('start-familiarize')).ok, true);
    await env.submit('duty', 'Organize documents');
    const memories = createMemoryStore({ rootDir: env.home }).list({ workspaceId: env.bot.workspaceId });
    const duty = memories.find(item => item.kind === 'responsibility');
    assert.equal(duty?.pinned, true); assert.equal(duty?.trust, 'stated');
    assert.deepEqual(duty.sourceRefs, ['input-duty']);
    assert.equal(env.history().filter(message => message.content === 'Organize documents').length, 1);
    const page = await env.invoke('read-conversation');
    assert.ok(page.messages.flatMap(message => message.cards || []).some(card => card.kind === 'readme_offer'));
    const [a, b] = await Promise.all([env.invoke('accept-readme'), env.invoke('accept-readme')]);
    assert.equal(a.ok, true); assert.equal(b.ok, true); assert.equal(env.plans.listPlans().length, 1);
    const plan = env.plans.getPlan(env.starts[0]); assert.equal(plan.delegationOrigin.readOnly, false);
    assert.equal((await env.invoke('accept-readme')).reused, true);
    assert.equal((await env.invoke('read-conversation')).messages.flatMap(message => message.cards || []).some(card => card.kind === 'readme_offer' && card.resolvedState === 'open'), false);
  } finally { env.dispose(); }
});

test('profile policies persist, reject invalid patches before writes, and feed live role routing', async () => {
  const env = harness();
  try {
    const policy = { scope: { modelProviderIds: [provider.id] }, overrides: { project_agent: { mode: 'fixed', modelProviderId: provider.id } } };
    const result = await env.invoke('update-profile', { planApproval: 'writes', acceptancePolicy: 'confirm', modelPolicy: policy });
    assert.equal(result.ok, true); assert.equal(result.profile.planApproval, 'writes'); assert.deepEqual(result.profile.modelPolicy, policy);
    assert.equal(env.api.listItems()[0].profile.planApproval, 'writes');
    assert.equal(env.api.listItems()[0].profile.acceptancePolicy, 'confirm');
    assert.deepEqual(env.api.listItems()[0].profile.modelPolicy, policy);
    const invalid = await env.invoke('update-profile', { displayName: 'bad change', modelPolicy: { overrides: { project_agent: { mode: 'fixed', modelProviderId: 'unknown' } } } });
    assert.equal(invalid.ok, false); assert.equal((await env.invoke('get')).profile.displayName, 'test');
    await env.submit(); assert.deepEqual(env.routes.find(route => route.role === 'project_agent').projectPolicy, policy);
    assert.equal((await env.invoke('get')).modelOptions[0].id, provider.id);
    const familiar = await env.invoke('start-familiarize'); assert.equal(familiar.ok, true);
    const sessionId = familiar.profile.familiarize.sessionId;
    assert.equal((await env.invoke('confirm-result', { workspaceId: 'foreign', sessionId })).ok, false);
    assert.equal((await env.invoke('confirm-result', { sessionId })).ok, false);
  } finally { env.dispose(); }
});

test('error retries reuse parked inputs, repeated clicks are idempotent, and recovery works across restart', async () => {
  let fail = true;
  const env = harness({ send: async () => fail ? { terminalStatus: 'error', error: 'offline' } : { terminalStatus: 'done', text: 'recovered' } });
  let resumed;
  try {
    await env.submit('recover', 'recover me');
    assert.equal(env.api.host.runnerFor(env.bot.workspaceId).status(), 'error');
    const card = env.history().find(message => message.card === 'agent_unavailable'); assert.ok(card);
    assert.equal(env.history().some(message => message.kind === 'agent_reply'), false);
    env.dispose(); fail = false;
    resumed = harness({ dataHome: env.home, folder: env.project, send: async () => ({ terminalStatus: 'done', text: 'recovered' }) });
    const [a, b] = await Promise.all([resumed.invoke('retry', { turnId: card.turnId }), resumed.invoke('retry', { turnId: card.turnId })]);
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    assert.equal(resumed.history().filter(message => message.kind === 'agent_reply' && message.content === 'recovered').length, 1);
    assert.equal((await resumed.invoke('retry', { turnId: card.turnId })).ok, true);
    assert.equal(resumed.history().filter(message => message.role === 'user' && message.id === 'input-recover').length, 1);
    assert.equal((await resumed.invoke('retry', { turnId: 'foreign' })).ok, false);
  } finally { env.dispose(); resumed?.dispose(); }
});

for (const policy of ['auto', 'confirm', 'write-failed']) test(`desktop reporting persists replies before ${policy} acceptance`, async () => {
  let env; let report = false; let sessionId;
  env = harness({ send: async input => {
    if (!report) return { terminalStatus: 'done', text: 'hello' };
    const args = { text: 'Verified result', replyTo: ['input-report'], sources: [sessionId], statusClaims: [{sessionId,status:env.api.supervisor.get({sessionId}).status}] };
    const result = await tool({ ...env, turnId: input.streamId }, 'post_reply', args);
    input.webContents.send('chat:stream:tool-call', { toolCallId: 'reply', tool: 'post_reply', args: { ...args, text: 'unvalidated text' } });
    input.webContents.send('chat:stream:tool-result', { toolCallId: 'reply', result: result.output });
    return { terminalStatus: 'done', toolCallCount: 1 };
  } });
  try {
    await env.invoke('update-profile', { acceptancePolicy: policy === 'write-failed' ? 'auto' : policy });
    await env.submit('anchor', 'read files');
    const opened = await env.invoke('start-familiarize');
    assert.equal(opened.ok, true);
    sessionId = opened.profile.familiarize.sessionId;
    const planId = env.api.supervisor.get({ sessionId }).planId;
    env.plans.revisePlan(planId, {
      tasks: [{ taskId: 'leaf', title: 'Read', status: 'completed', evidenceRefs: ['ev-pass'] }],
      successCriteria: [{ id: 'c1', kind: 'test', description: 'read complete' }],
      criterionResults: [{ criterionId: 'c1', passed: true, evidenceRef: 'ev-pass' }],
      hostVerification: { independentVerifier: 'passed', verifierModel: provider.id },
    }, { reason: 'verified host facts', changedBy: 'test' });
    env.plans.recordEvidenceRefs({ planId, evidenceRefs: ['ev-pass'],toolName:'read_file',capabilityId:'local.file.read',
      bodyPreview:{kind:'file',text:'Verified result',truncated:false} });
    env.plans.setPlanStatus(planId, 'completed');
    assert.equal(env.plans.getPlan(planId).resultAcceptance, undefined);
    if (policy === 'write-failed') {
      const revise = env.plans.revisePlan;
      env.plans.revisePlan = (id, patch, options) => {
        if (patch.resultAcceptance) throw Object.assign(new Error('Acceptance persistence rejected'), {code:'close_gate'});
        return revise(id, patch, options);
      };
    }
    report = true;
    await env.submit('report', 'report result');
    const reply = env.history().find(message => message.content === 'Verified result');
    assert.ok(reply); assert.equal(env.history().some(message => message.content === 'unvalidated text'), false);
    assert.equal(reply.marks[0].outcome, 'passed');
    assert.deepEqual(reply.meta.sessionStates, [{sessionId,status:policy === 'auto' ? 'accepted' : 'result_ready'}]);
    const learned = createMemoryStore({ rootDir: env.home }).list({ workspaceId: env.bot.workspaceId }).find(item => item.text === 'Verified result');
    assert.equal(learned?.trust, 'verified');
    assert.deepEqual(learned.sourceRefs, ['ev-pass']);
    assert.ok(reply.meta.memoryLearned.includes(learned.id));
    assert.equal((await env.invoke('get')).profile.familiarize.memoryRecorded, true);
    if (policy === 'auto') assert.equal(env.plans.getPlan(planId).resultAcceptance?.acceptedBy, 'policy');
    else if (policy === 'write-failed') assert.equal(env.plans.getPlan(planId).resultAcceptance, undefined);
    else {
      assert.equal(env.plans.getPlan(planId).resultAcceptance, undefined);
      const cards = (await env.invoke('read-conversation')).messages.flatMap(message => message.cards || []);
      assert.ok(cards.some(card => card.kind === 'confirm_result' && card.resolvedState === 'open'));
      const result = await env.invoke('confirm-result', { sessionId }); assert.equal(result.ok, true);
      assert.equal(env.plans.getPlan(planId).resultAcceptance.acceptedBy, 'user');
      const currentReply=(await env.invoke('read-conversation')).messages.find(message=>message.id===reply.id);
      assert.deepEqual(currentReply.meta.sessionStates,[{sessionId,status:'accepted'}]);
      assert.equal((await env.invoke('confirm-result', { sessionId })).alreadyAccepted, true);
      assert.equal((await env.invoke('read-conversation')).messages.flatMap(message => message.cards || []).some(card => card.kind === 'confirm_result' && card.resolvedState === 'open'), false);
    }
  } finally { env.dispose(); }
});

test('host rejects acceptance claims on blocked tasks and returns authoritative status through Grant/Evidence', async () => {
  const env = harness();
  try {
    await env.submit('anchor', 'read files');
    const opened=await env.invoke('start-familiarize');
    const sessionId=opened.profile.familiarize.sessionId;
    const planId=env.api.supervisor.get({sessionId}).planId;
    env.plans.revisePlan(planId,{hostVerification:{independentVerifier:'passed'},
      runner:{status:'blocked',blockedReason:'Verifier report format invalid'}},
      {reason:'reproduce blocked verification',changedBy:'test'});
    const actual=env.api.supervisor.get({sessionId}).status;
    assert.notEqual(actual,'accepted');
    const reply=await tool(env,'post_reply',{text:'Already accepted',replyTo:['input-anchor'],sources:[sessionId],
      statusClaims:[{sessionId,status:'accepted'}]});
    assert.equal(reply.success,false);
    const output=JSON.parse(reply.output);
    assert.equal(output.error,'status_claim_mismatch');
    assert.deepEqual(output.sessionStates,[{sessionId,status:actual}]);
    assert.equal(env.plans.getPlan(planId).resultAcceptance,undefined);
    assert.equal(env.history().some(message=>message.content==='Already accepted'),false);
    assert.equal(reply.execution.result.status,'failed');
    assert.ok(reply.execution.result.evidence.evidenceId);
  } finally {env.dispose();}
});

test('reply source ownership includes sessions beyond the model list page', async () => {
  const env = harness();
  try {
    await env.submit('anchor', 'read files');
    let latest;
    for (let n = 0; n < 51; n++) {
      latest = await env.api.supervisor.spawn({ anchorMessageIds: ['input-anchor'], title: `Read ${n}`, brief: 'Read files', kind: 'research', readOnly: true, successCriteria: ['Read'] },
        { parentConversationId: env.bot.profile.agentConversationId, workspaceId: env.bot.workspaceId, workspacePath: env.project });
      assert.ok(latest.sessionId);
    }
    assert.equal(env.api.supervisor.list({ workspaceId: env.bot.workspaceId }).length, 50);
    assert.equal(env.api.supervisor.sessionsForProject(env.bot.workspaceId).length, 51);
    assert.equal(env.api.supervisor.sessionsForProject('foreign').length, 0);
    const reply = await tool(env, 'post_reply', { text: 'Last task', sources: [latest.sessionId], statusClaims: [{sessionId:latest.sessionId,status:env.api.supervisor.get({sessionId:latest.sessionId}).status}], replyTo: ['input-anchor'] });
    assert.equal(reply.success, true, JSON.stringify(reply));
  } finally { env.dispose(); }
});

test('production registration shares executor scheduling with supervisor and reads live global settings', async () => {
  const settings={projectAgent:{concurrency:1}};
  const env=harness({settings});
  try {
    assert.equal(env.api.supervisor.executionScheduler,env.executor.executionScheduler);
    assert.equal(env.executor.executionScheduler.stats().limit,1);
    settings.projectAgent.concurrency=3;
    assert.equal(env.api.supervisor.executionScheduler.stats().limit,3);
    await env.submit('sched-anchor','紧急，请优先处理第三个读取任务');
    env.currentInputAnchors = env.calls.at(-1).turnProfile.context.inputAnchors.map(anchor => anchor.messageId);
    assert.equal(env.history().find(message => message.id === 'input-sched-anchor').kind, 'user_input');
    const ids=[];
    for(let n=0;n<3;n++) {
      const result=JSON.parse((await tool(env,'spawn_session',{anchorMessageIds:['input-sched-anchor'],title:`读取任务${n}`,brief:`读取不同文件${n}`,
        kind:'research',readOnly:true,successCriteria:['读取内容'],priority:n===2?'high':'normal'})).output);
      assert.ok(result.sessionId,result.error);ids.push(result.sessionId);
    }
    assert.equal(env.starts.length,2);
    assert.equal(env.api.supervisor.get({sessionId:ids[2]}).status,'queued');
    assert.equal(env.api.supervisor.get({sessionId:ids[2]}).queuedBehind.length,2);
    await env.api.supervisor.cancel({sessionId:ids[0]});
    assert.equal(env.starts.length,3);
  } finally {env.dispose();}
});

test('production failed dependency projects a question and an answer does not start the blocked child', async () => {
  const env=harness();
  try {
    await env.submit('dep-anchor','处理依赖');
    const args={anchorMessageIds:['input-dep-anchor'],title:'前置任务',brief:'前置任务',kind:'research',readOnly:true,successCriteria:['读取内容']};
    const dep=JSON.parse((await tool(env,'spawn_session',args)).output);
    const child=JSON.parse((await tool(env,'spawn_session',{...args,title:'后续任务',brief:'等待签收',dependsOn:[dep.sessionId]})).output);
    await env.api.supervisor.cancel({sessionId:dep.sessionId});
    const cards=(await env.invoke('read-conversation')).messages.flatMap(message=>message.cards || []);
    const card=cards.find(c=>c.cardId===`card:question:${child.sessionId}:dependency`);
    assert.ok(card);assert.equal(card.kind,'question');
    assert.equal(env.api.supervisor.get({sessionId:child.sessionId}).status,'waiting_user');
    assert.equal(env.starts.length,1);
    const answer=await env.invoke('submit-input',{inputId:'dependency-answer',text:'重新安排任务',answerTo:card.cardId});
    assert.equal(answer.ok,true);await env.api.host.sync([env.bot.workspaceId]);
    assert.equal(env.starts.length,1);
    assert.equal(env.api.supervisor.get({sessionId:child.sessionId}).status,'waiting_user');
  } finally {env.dispose();}
});

test('classic shell leaves queued bot input unconsumed and starts no bot or delegated work', async () => {
  const initial = harness(); await initial.submit('old', 'old'); initial.dispose();
  const env = harness({ dataHome: initial.home, folder: initial.project, settings: { projectAgent: { shell: 'classic' } } });
  try {
    env.api.host.inputQueue.submitInput({ workspaceId: initial.bot.workspaceId, inputId: 'classic-pending', text: 'wait', surface: 'desktop' });
    const before = env.api.host.inputQueue.cursor(initial.bot.workspaceId);
    await env.api.host.sync([initial.bot.workspaceId]);
    assert.equal(env.api.host.inputQueue.cursor(initial.bot.workspaceId), before);
    assert.equal(env.calls.length, 0); assert.equal(env.starts.length, 0); assert.equal(env.api.host.isReady(initial.bot.workspaceId), false);
    assert.equal((await env.invoke('start-familiarize')).code, 'PROJECT_AGENT_DISABLED');
  } finally { env.dispose(); }
});

test('desktop daily memory maintenance obeys classic, lease and memory switches and uses no model', async () => {
  for (const scenario of [{settings:{projectAgent:{digestTime:'00:00'}},expected:'expired'}, {settings:{projectAgent:{shell:'classic',digestTime:'00:00'}},expected:'active'}, {settings:{projectAgent:{digestTime:'00:00'},memory:{enabled:false}},expected:'active'}, {settings:{projectAgent:{digestTime:'00:00'}},holdsLease:()=>false,expected:'active'}]) {
    const initial=harness();initial.dispose();
    const env=harness({...scenario,dataHome:initial.home,folder:initial.project});
    try {
      const store=createMemoryStore({rootDir:env.home});
      const item=store.writeVerified({workspaceId:env.bot.workspaceId,kind:'fact',text:'temporary',sourceRefs:['ev'],expiresAt:'2020-01-01T00:00:00Z'}).item;
      await env.api.host.sync([env.bot.workspaceId]);
      assert.equal(store.get(item.id).status,scenario.expected);
      assert.equal(env.calls.length,0);
    } finally {env.dispose();}
  }
});

test('global bot search excludes changed, expired and conflicted memories', async()=>{
  const env=harness();
  try {
    const store=createMemoryStore({rootDir:env.home});
    const stale=store.writeVerified({workspaceId:env.bot.workspaceId,kind:'fact',text:'searchvalidity stale',sourceRefs:['ev']}).item;
    store.markMaintained({id:stale.id,workspaceId:env.bot.workspaceId,needsReverify:true});
    store.writeVerified({workspaceId:env.bot.workspaceId,kind:'fact',text:'searchvalidity expired',sourceRefs:['ev-expiry'],expiresAt:'2020-01-01T00:00:00Z'});
    store.writeVerified({workspaceId:env.bot.workspaceId,kind:'fact',text:'searchvalidity fresh',sourceRefs:['ev-fresh']});
    const result=await env.invoke('search',{query:'searchvalidity'});
    assert.equal(result.ok,true);const memories=result.hits.filter(hit=>hit.kind==='memory');assert.equal(memories.length,1);assert.match(JSON.stringify(memories[0]),/fresh/);
  }finally{env.dispose();}
});
