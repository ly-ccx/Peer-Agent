import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createGoalPlanStore } from '@peer-agent/runtime-node/storage';
import { createProjectGoalRunnerHost, resolveWorkSessionProfile, createSessionVerification } from '@peer-agent/runtime-node/project-agent';
import { createInteractiveRuntime } from '@peer-agent/runtime-node/interactive-results';
import { interactiveFeedbackFromFollowup, encodeResourceFeedbackTransport } from '@peer-agent/protocol';
import { createTuiHost } from '../tui-host.ts';
import { createProviderChatModel } from '../provider-chat-model.ts';
import { createTuiModelSelectionControl } from '../tui-model-selection.ts';
import { buildTuiSystemPrompt } from '../tui-language.ts';
import { createInteractiveToolProvider } from './interactive-tool-provider.ts';
import { createTuiTurnExecutor } from './tui-turn-executor.ts';
import { createTurnTestRuntime, drainTestCleanup, type TestCleanup } from './turn-test-support.ts';

test('actual TUI GoalHost → Executor → Pipeline → readonly Provider indexes fixed initial and frozen-condition evidence', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'peer-tui-interactive-verifier-'))), cleanup: TestCleanup[] = [];
  const conversations = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const parent = conversations.createConversation({ role: 'project_agent', workspaceId: 'bot' });
  const child = conversations.createConversation({ role: 'work_session', workspaceId: 'bot' });
  mkdirSync(path.join(root, 'projects/bot'), { recursive: true });
  writeFileSync(path.join(root, 'projects/bot/profile.json'), JSON.stringify({ workspaceId: 'bot', agentConversationId: parent.id,
    status: 'active', displayName: 'Fixture', avatar: { kind: 'generated' } }));
  const plans = createGoalPlanStore({ storeDir: path.join(root, 'plans') });
  const model = { modelProviderId: 'configured', providerId: 'fixture', modelId: 'test-model', family: 'fixture' };
  const plan = plans.createPlan({ conversationId: child.id, title: 'Verify trial', goal: 'Verify the fixed divisor trial', status: 'executing',
    tasks: [{ taskId: 'trial', title: 'Publish trial', status: 'pending' }],
    successCriteria: [{ id: 'meaning', kind: 'model_review', description: 'The fixed program divides the total by the selected divisor.' }],
    delegationOrigin: { workspaceId: 'bot', parentConversationId: parent.id, sessionId: 'session', anchorMessageId: 'anchor', inputId: 'input',
      phase: 'running', readOnly: true, modelSelection: { worker: model, explorer: model, verifier: model, resolvedAt: new Date().toISOString() } } });
  const interactive = createInteractiveRuntime({ rootDir: path.join(root, 'runtime'), goalPlanStore: plans, conversationStore: conversations,
    getBotConversationId: () => parent.id, holdsLease: () => true, enabled: () => true, classifyContext: () => 'D3_private' });
  const owner = { workspaceId: 'bot', conversationId: parent.id };
  let rounds = 0, frozen: any, reference: any, bindingToken = '';
  const requests: any[] = [];
  try {
    const published = await interactive.provider.executeCapability({ call: { toolCallId: 'publish', capabilityId: 'local.interactive.publish', arguments: {
      publication: { kind: 'create' }, title: 'Trial', textFallback: 'Unverified fixed trial',
      program: '$x=2\nroot=Col([NumberInput("x","Divisor",$x,1,10,1),Metric("Ratio",@Total(@Data("facts"),"cost")/$x)])',
      inputs: [{ bindingId: 'facts', source: { kind: 'model-data', value: [{ cost: 20 }] } }],
    } } }, { toolContext: { workspaceId: 'bot', conversationId: child.id, turnProfile: resolveWorkSessionProfile({ plan, kind: 'worker' }) },
      requestPermission: async () => ({ granted: true }) });
    expect(published!.result.status).toBe('success'); reference = (published!.result.outputPreview as any).reference;
    plans.recordTaskEvidence(plan.planId, 'trial', { status: 'completed', evidenceRefs: [(published!.result.outputPreview as any).artifactRef] });
    const identity = { viewId: 'human', windowId: 'window', generation: 'generation' };
    const before = interactive.stateStore.read(reference, () => true);
    const writer = interactive.stateStore.acquire({ reference, identity, expectedRevision: before.stateRevision }, () => true);
    const saved = interactive.stateStore.save({ reference, identity, writer, expectedRevision: before.stateRevision, requestId: 'save', values: { $x: 4 }, inputDrafts: {} }, () => true);
    frozen = await interactive.stateStore.prepareFollowup({ reference, identity, writer, requestId: 'freeze', stateRevision: saved.stateRevision,
      stateDigest: saved.stateDigest, fields: ['$x'] }, () => true);
    conversations.appendMessage(child.id, { id: 'selected', role: 'user', content: 'Check these conditions',
      ...encodeResourceFeedbackTransport([interactiveFeedbackFromFollowup(frozen)!]) });
    const provider = createInteractiveToolProvider(interactive);
    const executor = createTuiTurnExecutor({ dataHome: root, goalPlanStore: plans, getSettings: () => ({ localAccessLevel: 'full_local' }),
      holdsLease: () => true, resolveWorkspacePath: () => root, readMessages: id => conversations.getPersistedConversationHistory?.(id)?.messages ?? [],
      readMemory: () => [], memoryEnabled: () => false, getProviders: () => [provider], captureExecution: interactive.captureExecution,
      createRuntime(options) {
        const host = createTuiHost({ ...options, accessLevel: 'full_local' });
        return createTurnTestRuntime({ host,
          modelSelection: createTuiModelSelectionControl({ providerId: 'configured', modelId: 'test-model', displayName: 'Fixture' }),
          model: createProviderChatModel({ model: 'test-model', toolDefinitionsForMode: mode => host.toolDefinitionsForMode!(mode),
            getSystemPrompt: context => buildTuiSystemPrompt({}, { ...context.systemContextInput, mode: context.mode }),
            provider: { async stream(request) {
              requests.push(request); rounds++;
              if (rounds === 1) return { content: '', toolCalls: [
                { view: 'program' }, { view: 'data', bindingId: 'facts' }, { view: 'evaluate' }, { view: 'evaluate', followupId: frozen.followupId },
              ].map((extra, i) => ({ id: `inspect-${i}`, name: 'inspect_interactive_result', arguments: JSON.stringify({ target: { kind: 'result', reference }, ...extra }) })) };
              const refs = plans.listEvidenceIndex().filter((row: any) => row.interactiveInspection).map(row => row.evidenceRef);
              const content = JSON.stringify({ passed: true, evidenceRefs: refs, summary: 'Controlled transport reviewed the actual fixed outputs.' });
              request.onEvent?.({ type: 'text.delta', content });
              return { content, toolCalls: [] };
            } },
          }),
        }, cleanup);
      },
    });
    cleanup.push(() => executor.stop());
    const host = createProjectGoalRunnerHost({ goalPlanStore: plans, conversationStore: conversations,
      agentTurnExecutor: { ...executor, runTurn(input: any) { bindingToken = input.turnProfile.interactiveReview.token; return executor.runTurn(input); } },
      llmChatService: {}, hostLeases: { holds: () => true }, broadcast() {}, workspaceRoot: root,
      resolveConversationModelProviderId: () => 'configured', getInteractiveVerification: () => interactive.verification });
    const verification = createSessionVerification({ goalPlanStore: plans,
      verifySession: (current: any) => host.verifierRunner.runVerifier({ plan: current, verifierRunId: 'tui-review', stage: 'delegated',
        signal: undefined, focus: undefined, workId: undefined, goalReview: undefined }) } as never);
    const verdict = await verification.run({ sessionId: 'session' });
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true); expect('facts' in verdict && verdict.facts?.independentVerifier).toBe('passed'); expect(rounds).toBe(2);
    expect(requests[0].tools.some((tool: any) => tool.name === 'inspect_interactive_result')).toBe(true);
    expect(requests[0].tools.some((tool: any) => ['publish_interactive_result', 'write_file', 'bash'].includes(tool.name))).toBe(false);
    expect(JSON.stringify(requests).includes(bindingToken)).toBe(false);
    const receipts = plans.listEvidenceIndex().filter((row: any) => row.interactiveInspection);
    expect(receipts).toHaveLength(4);
    expect(receipts.every((row: any) => row.planId === plan.planId && row.conversationId === child.id && row.interactiveInspection.owner.conversationId === owner.conversationId)).toBe(true);
    expect(receipts.some((row: any) => row.interactiveInspection.stateSource?.followupId === frozen.followupId)).toBe(true);
  } finally { await drainTestCleanup(cleanup); interactive.close(); rmSync(root, { recursive: true, force: true }); }
});
