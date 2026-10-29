import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'peer-review-continuation-'));
const oldHome = process.env.PEER_AGENT_HOME;
process.env.PEER_AGENT_HOME = root;
const { createGoalPlanStore, registerWorkBudget, createProjectGoalRunnerHost } = await import('@peer-agent/runtime-node');
const { createWorkCoordinationStore } = await import('../../../../../packages/runtime-node/src/project-agent/work-coordination-store.mjs');
const { createAgentTurnExecutor } = await import('./agent-turn-executor.mjs');
const { agentLoopOpenAI } = await import('../chat-runtime/openai-agent-loop.mjs');
const { createRuntimeToolProjection, buildOpenAIToolsFromModelProjection } = await import('../tools/index.mjs');

test('production Verifier → Executor → Responses loop → readonly File Provider crosses 12 rounds with real paired evidence', async t => {
  const oldFetch = globalThis.fetch;
  let release = () => {};
  t.after(() => { globalThis.fetch = oldFetch; release();
    if (oldHome === undefined) delete process.env.PEER_AGENT_HOME; else process.env.PEER_AGENT_HOME = oldHome;
    rmSync(root, { recursive: true, force: true }); });
  const plans = createGoalPlanStore({ storeDir: path.join(root, 'plans') });
  const coord = createWorkCoordinationStore({ rootDir: path.join(root, 'coordination'), workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'test' });
  coord.saveWork({ workId: 'work', workspaceId: 'w', parentConversationId: 'parent', state: 'waiting_children', stopScope: 'reply' });
  release = registerWorkBudget('w', coord);
  const model = { providerId: 'fixture', modelProviderId: 'fixture', modelId: 'fixture', family: 'openai' };
  const plan = plans.createPlan({ title: 'Check 13 actual files', goal: 'Review existing evidence', status: 'executing',
    tasks: [{ taskId: 't', title: 'Implementation', status: 'completed', result: 'Implemented', evidenceRefs: ['initial'] }],
    delegationOrigin: { sessionId: 's', workspaceId: 'w', parentConversationId: 'parent', workId: 'work', phase: 'running',
      anchorMessageId: 'u', inputId: 'i', surface: 'desktop', depth: 1, readOnly: false,
      modelSelection: { worker: model, explorer: model, verifier: model, source: { worker: 'global', verifier: 'global' }, resolvedAt: new Date().toISOString() } } });
  plans.setRunnerState(plan.planId, { status: 'blocked', blockedReason: 'Verification gate failed: quality:criterion_unverified' });
  for (let i = 1; i <= 13; i++) writeFileSync(path.join(root, `fixture-${i}.txt`), `actual readonly finding ${i}`);
  const allEvents = [], requests = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const count = requests.length;
    assert.ok(count <= 14, 'no extra provider request or worker replay');
    if (count === 13) assert.ok(JSON.stringify(request).includes('actual readonly finding 1'), 'the second slice restores the first paired Tool Result');
    const refs = allEvents.filter(row => row.channel === 'chat:stream:tool-result').flatMap(row => row.payload.evidenceRefs || []);
    const frames = count <= 13 ? [
      { type: 'response.output_item.added', item: { type: 'function_call', id: `fc-${count}`, call_id: `read-${count}`, name: 'read_file' } },
      { type: 'response.function_call_arguments.done', item_id: `fc-${count}`, arguments: JSON.stringify({ path: `fixture-${count}.txt` }) },
      { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20 } } },
    ] : [
      { type: 'response.output_text.delta', delta: JSON.stringify({ passed: true, evidenceRefs: [refs[0]], summary: '13 real files reviewed' }) },
      { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20 } } },
    ];
    return new Response(frames.map(row => `data: ${JSON.stringify(row)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const executor = createAgentTurnExecutor({ llmChatService: { async sendMessage(input) {
    const { registry, projection, modelProjection } = createRuntimeToolProjection({ projectionOptions: { mode: 'explorer', readOnlyWorkSession: true } });
    await agentLoopOpenAI({ baseUrl: 'https://fixture.invalid', apiKey: 'controlled-transport', authMethod: 'oauth_chatgpt',
      providerId: 'fixture', model: 'fixture', systemPrompt: 'Readonly verifier.', messages: input.messages,
      tools: buildOpenAIToolsFromModelProjection(modelProjection), streamId: input.streamId, signal: input.signal,
      executionBudget: input.executionBudget, workspacePath: root, conversationId: null, runtimeMode: 'explorer',
      registry, runtimeProjection: projection, goalPlanStore: plans,
      toolContext: { mode: 'explorer', turnRole: 'work_session', agentKind: 'verifier', planId: plan.planId,
        workspaceId: 'w', readFiles: new Map(), turnToolCalls: [], turnId: input.streamId },
      permissionGate: { createFilePermissionRequester: () => async () => ({ granted: true }),
        createLocalCapabilityPermissionRequester: () => async () => ({ granted: true }),
        createShellApprovalDecider: () => async () => ({ granted: true }) },
      webContents: { send(channel, payload) { allEvents.push({ channel, payload }); input.sink?.send?.(channel, payload); input.webContents.send(channel, payload); } },
    });
    return { terminalStatus: 'done' };
  } } });
  const host = createProjectGoalRunnerHost({ agentTurnExecutor: executor, goalPlanStore: plans,
    conversationStore: { getConversation: () => null, getPersistedConversationHistory: () => ({ messages: [] }) },
    llmChatService: {}, broadcast() {}, hostLeases: { holds: () => true }, workspaceRoot: root, resolveConversationModelProviderId: () => 'fixture' });
  const verdict = await host.verifierRunner.runVerifier({ plan: plans.getPlan(plan.planId), verifierRunId: 'review', stage: 'delegated' });
  assert.equal(verdict.passed, true);
  assert.equal(requests.length, 14);
  assert.equal(allEvents.filter(row => row.channel === 'chat:stream:tool-result').length, 13);
  assert.equal(allEvents.some(row => row.channel === 'chat:stream:error'), false);
  assert.equal(new Set(allEvents.filter(row => row.channel === 'chat:stream:tool-call').map(row => row.payload.toolCallId)).size, 13);
  const saved = plans.getPlan(plan.planId).runner.verificationContinuation;
  assert.equal(saved.modelRequests, 14); assert.equal(saved.toolCalls, 13);
  assert.match(saved.checkpointRef, /^[a-f0-9]{64}\.json$/);
  assert.equal(coord.read().works.work.budget.modelRequests, 14);
  assert.equal(coord.read().works.work.budget.toolCalls, 13);
  assert.equal(plans.getPlan(plan.planId).delegationOrigin.readOnly, false, 'readonly review never changes the worker contract');
});
