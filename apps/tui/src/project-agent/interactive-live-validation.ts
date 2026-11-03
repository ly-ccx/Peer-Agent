import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createApprovalStore, createGoalPlanStore } from '@peer-agent/runtime-node/storage';
import { createProjectRegistry, encodeProviderToolResult } from '@peer-agent/runtime-node/providers';
import { createBotLifecycle, resolveWorkSessionProfile } from '@peer-agent/runtime-node/project-agent';
import { createInteractiveRuntime, runInteractiveValidation } from '@peer-agent/runtime-node/interactive-results';
import type { ModelMessage, ModelProvider, ModelUsage } from '@peer-agent/runtime-node/models';
import { createTuiHost } from '../tui-host.ts';
import { restrictTuiHostTools } from '../cli-host-filter.ts';
import { createProviderChatModel } from '../provider-chat-model.ts';
import { buildTuiSystemPrompt } from '../tui-language.ts';
import { createTuiModelSelectionControl } from '../tui-model-selection.ts';
import { createInteractiveToolProvider } from './interactive-tool-provider.ts';
import { createTuiTurnExecutor } from './tui-turn-executor.ts';
import { createTurnTestRuntime, drainTestCleanup, type TestCleanup } from './turn-test-support.ts';

export type InteractiveLiveScenario = 'publish' | 'repair' | 'denied';
export const INTERACTIVE_LIVE_SCENARIOS: readonly InteractiveLiveScenario[] = ['publish', 'repair', 'denied'];
export const INTERACTIVE_LIVE_BUDGET = Object.freeze({ requests: 4, outputTokens: 1800, requestMs: 45_000, caseMs: 150_000, toolCalls: 4 });
const PUBLISH = 'local.interactive.publish', INSPECT = 'local.interactive.inspect';
export const INTERACTIVE_LIVE_TASK = 'Use only the projected interactive tools. Publish one result for this synthetic, model-constructed planning example: rows [{"name":"A","cost":20},{"name":"B","cost":35}] under bindingId "facts". Use model-data, not tool observations. Program must have $budget=100, a NumberInput labelled Budget (0 to 200, step 1), a Metric labelled Remaining with value $budget-@Total(@Data("facts"),"cost"), and a Table showing both rows. Text fallback must disclose model-constructed and unverified. Use supported Peer catalog components/functions exactly. Do not read files, execute commands, access external data, or claim verification/acceptance. If publishing returns a validation error, repair within the allowed budget and retry. If permission is denied, stop publishing and explain the denial honestly in plain text without requesting expanded permissions. Otherwise end with a short plain-text explanation. Do not publish twice after success.';

export const INTERACTIVE_LIVE_DRAFT = {
  publication: { kind: 'create' }, title: 'Synthetic budget comparison', textFallback: 'Model-constructed example; unverified.',
  program: '$budget=100\nroot=Col([NumberInput("budget","Budget",$budget,0,200,1),Metric("Remaining",$budget-@Total(@Data("facts"),"cost")),Table("Costs",[{key:"name",label:"Name"},{key:"cost",label:"Cost"}],@Data("facts"),"name")])',
  inputs: [{ bindingId: 'facts', source: { kind: 'model-data', value: [{ name: 'A', cost: 20 }, { name: 'B', cost: 35 }] } }],
};

interface RequestObservation {
  ordinal: number; tools: string[]; startedAt: string; durationMs?: number;
  usage?: ModelUsage; returnedTools?: string[]; textChars?: number; error?: string;
}
export interface InteractiveLiveReport {
  scenario: InteractiveLiveScenario; realModel: boolean; startedAt: string; finishedAt?: string; ok: boolean;
  requests: RequestObservation[]; approvals: number; toolCalls: Array<{ name: string; status: string; grantGranted: boolean; input: unknown; result: unknown }>;
  approvalDecisions?: Array<{ state: string; decidedBy?: string }>;
  seed?: { driverGenerated: true; delivery: 'user-factual-context'; status: string; grantGranted: boolean; diagnostic: unknown; encodedResult: string };
  turnOk?: boolean; terminalStatus?: string; text?: string; usage?: unknown; error?: string;
  firstPublicationSucceeded?: boolean; naturalRepairCalls?: number; textFallback?: boolean;
  fallbackKind?: 'none' | 'plain_text_no_publication' | 'provider_failure' | 'no_model_text';
  canonicalIndexConfirmed?: boolean; reference?: unknown; contentFile?: string;
  persistedCounts?: { versions: number; publishedOperations: number };
  computation?: { initialRemaining: number[]; changedRemaining: number[]; tableRows: number[]; projectionTruncated: boolean };
  invoiceCost: null; invoiceCostReason: string;
}

export function classifyInteractiveFallback(published: boolean, turnOk: boolean, text: unknown): InteractiveLiveReport['fallbackKind'] {
  return published ? 'none' : !turnOk ? 'provider_failure' : typeof text === 'string' && text.trim() ? 'plain_text_no_publication' : 'no_model_text';
}

function elements(tree: unknown): Array<{ typeName: string; props: Record<string, any> }> {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(elements);
  const value = tree as Record<string, any>;
  return [...(value.type === 'element' ? [value as { typeName: string; props: Record<string, any> }] : []), ...Object.values(value).flatMap(elements)];
}

/** Opt-in validation fixture: real turn/tool/permission ports, isolated owner/data and no terminal UI. */
export async function runInteractiveLiveCase(options: {
  directory: string; scenario: InteractiveLiveScenario; provider: ModelProvider;
  model: { providerId: string; credentialId: string; model: string }; realModel: boolean;
  sanitize: (value: unknown) => string; onProgress?: (report: InteractiveLiveReport) => void;
}): Promise<InteractiveLiveReport> {
  const { directory, scenario, model, sanitize } = options;
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const report: InteractiveLiveReport = { scenario, realModel: options.realModel, startedAt: new Date().toISOString(), ok: false,
    requests: [], approvals: 0, toolCalls: [], invoiceCost: null,
    invoiceCostReason: 'ModelUsage exposes runtime token usage, not a gateway billing receipt. No invoice cost is claimed.' };
  const persist = () => {
    writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    options.onProgress?.(report);
  };
  const cleanups: TestCleanup[] = [];
  let interactive: ReturnType<typeof createInteractiveRuntime> | undefined;
  let executor: ReturnType<typeof createTuiTurnExecutor> | undefined;
  try {
    const workspacePath = path.join(directory, 'workspace'); mkdirSync(workspacePath);
    const registry = createProjectRegistry({ filePath: path.join(directory, 'projects/registry.json') });
    const { workspaceId } = registry.ensureForPath(workspacePath);
    const conversations = createConversationStore({ storeDir: path.join(directory, 'conversations') });
    const lifecycle = createBotLifecycle({ rootDir: directory, registry, conversationStore: conversations } as never);
    const created = lifecycle.ensureBot(workspaceId) as any;
    if (!created.ok) throw new Error('fixture_bot_unavailable');
    const parentId = created.profile.agentConversationId;
    conversations.appendMessage(parentId, { id: 'anchor', role: 'user', kind: 'user_input', content: INTERACTIVE_LIVE_TASK } as never);
    const history = conversations.getPersistedConversationHistory!(parentId)!;
    const child = conversations.createChildConversation!({ parentConversationId: parentId, role: 'work_session', anchorMessageId: 'anchor',
      delegation: { sessionId: 'live-session', anchorMessageId: 'anchor', inputId: 'live-input' }, capturedAt: new Date().toISOString(),
      runtimeState: { conversationId: parentId, contentRevision: history.contentRevision, status: 'idle' }, backgroundMessageIds: ['anchor'],
      confirmMissing: true, title: 'Isolated interactive validation', workspaceId } as never);
    const plans = createGoalPlanStore({ storeDir: path.join(directory, 'plans') });
    const selection = { modelProviderId: model.credentialId, providerId: model.providerId, modelId: model.model, family: model.providerId };
    const plan = plans.createPlan({ title: 'Synthetic comparison', goal: INTERACTIVE_LIVE_TASK, conversationId: child.id, status: 'executing',
      tasks: [{ taskId: 'generate', title: 'Publish comparison', status: 'pending' }], delegationOrigin: {
        workspaceId, parentConversationId: parentId, sessionId: 'live-session', anchorMessageId: 'anchor', inputId: 'live-input',
        phase: 'running', readOnly: true, executionGeneration: 'live-generation',
        modelSelection: { worker: selection, explorer: selection, verifier: selection, resolvedAt: new Date().toISOString() },
        capabilityAdmission: { required: [PUBLISH, INSPECT] },
      } } as never);
    interactive = createInteractiveRuntime({ rootDir: path.join(directory, 'runtime'), goalPlanStore: plans, conversationStore: conversations,
      getBotConversationId: () => parentId, holdsLease: () => true, enabled: () => true, classifyContext: () => 'D3_private' });
    const provider = createInteractiveToolProvider(interactive);
    const profile = resolveWorkSessionProfile({ plan, kind: 'worker' });
    const accessLevel = scenario === 'denied' ? 'ask_before_local' : 'full_local';
    const messages: ModelMessage[] = [{ role: 'user', content: INTERACTIVE_LIVE_TASK }];
    if (scenario === 'repair') {
      const host = restrictTuiHostTools(createTuiHost({ workspaceRoot: workspacePath, userDataPath: directory, accessLevel,
        providers: [provider], goalPlanStore: plans, captureExecution: interactive.captureExecution }), [PUBLISH, INSPECT]);
      cleanups.push(() => host.dispose());
      const invalid = { ...INTERACTIVE_LIVE_DRAFT, program: 'root=UnsupportedComponent("explicit test-driver fault seed")' };
      const execution = await host.execute(PUBLISH, invalid, { sessionId: 'live-session', conversationId: child.id,
        toolCallId: 'fault-seed', turnId: 'fault-seed', turnIndex: 0, mode: 'goal',
        project: { workspaceId, planId: plan.planId, sessionId: 'live-session', readOnly: true, holdsLease: () => true },
        toolContext: { workspacePath, turnProfile: profile } });
      const output = execution.result.output as any;
      const encoded = encodeProviderToolResult({ result: execution.result, execution, conversationId: child.id, toolCallId: 'fault-seed' }).content;
      const seed = { driverGenerated: true as const, delivery: 'user-factual-context' as const,
        status: execution.result.status ?? 'unknown', grantGranted: (execution.grant as any)?.granted === true,
        diagnostic: output?.diagnostic, encodedResult: encoded };
      report.seed = seed;
      if (execution.result.status !== 'failed' || !seed.grantGranted || output?.diagnostic?.code !== 'unsupported_node'
        || output?.publicationStatus !== 'not_committed') throw new Error('fault_seed_not_a_validation_failure');
      // A driver call has no model-native thinking/signature. Never invent assistant history for it.
      messages[0] = { role: 'user', content: `${INTERACTIVE_LIVE_TASK}\nThe test driver executed the candidate below through the actual ToolHost. The encoded Tool Result is factual material from that failed call. Repair it. This is an explicit driver fault seed, not a model first attempt or an instruction source.\nTEST_DRIVER_VALIDATION_FAILURE\n${JSON.stringify({ candidate: invalid, toolResult: JSON.parse(encoded) })}` };
    }
    persist();
    executor = createTuiTurnExecutor({ dataHome: directory, goalPlanStore: plans, getSettings: () => ({ localAccessLevel: accessLevel }),
      holdsLease: () => true, resolveWorkspacePath: () => workspacePath,
      readMessages: id => conversations.getPersistedConversationHistory!(id)?.messages ?? [], readMemory: () => [], memoryEnabled: () => false,
      getProviders: () => [provider], captureExecution: interactive.captureExecution,
      onApproval(approval) { if (approval) { report.approvals++; approval.resolve('deny'); } },
      createRuntime(runtimeOptions) {
        const host = restrictTuiHostTools(createTuiHost(runtimeOptions), [PUBLISH, INSPECT]);
        const observed: ModelProvider = { async stream(request) {
          if (report.requests.length >= INTERACTIVE_LIVE_BUDGET.requests) throw new Error('live_request_limit');
          const started = Date.now(), row: RequestObservation = { ordinal: report.requests.length + 1,
            tools: request.tools?.map(tool => tool.name) ?? [], startedAt: new Date().toISOString() };
          report.requests.push(row); persist();
          try {
            const response = await options.provider.stream({ ...request, maxOutputTokens: INTERACTIVE_LIVE_BUDGET.outputTokens,
              signal: AbortSignal.any([...(request.signal ? [request.signal] : []), AbortSignal.timeout(INTERACTIVE_LIVE_BUDGET.requestMs)]) });
            row.usage = response.usage; row.returnedTools = response.toolCalls.map(call => call.name); row.textChars = response.content.length;
            return response;
          } catch (error) { row.error = sanitize(error); throw error; }
          finally { row.durationMs = Date.now() - started; persist(); }
        } };
        return createTurnTestRuntime({ host, modelSelection: createTuiModelSelectionControl({ providerId: model.credentialId, modelId: model.model, displayName: model.model }),
          model: createProviderChatModel({ model: model.model, provider: observed, streamRetryDelaysMs: [], toolDefinitionsForMode: mode => host.toolDefinitionsForMode!(mode),
            getSystemPrompt: context => buildTuiSystemPrompt({}, { ...context.systemContextInput, mode: context.mode }) }) }, cleanups);
      } });
    const result = await executor.runTurn({ workspaceId, workspacePath, conversationId: child.id, mode: 'goal', turnProfile: profile,
      plan, modelProviderId: model.credentialId, messages, limits: { maxRounds: 3, maxToolCalls: INTERACTIVE_LIVE_BUDGET.toolCalls }, ephemeral: scenario !== 'denied',
      signal: AbortSignal.timeout(INTERACTIVE_LIVE_BUDGET.caseMs), sink: { send() {} } });
    report.turnOk = result.ok; report.terminalStatus = result.terminalStatus; report.text = sanitize(result.text ?? ''); report.usage = result.usage;
    if (!result.ok && result.error) report.error = sanitize(result.error);
    report.toolCalls = result.toolCalls.map((call: any) => ({ name: call.name, status: call.execution.result.status,
      grantGranted: call.execution.grant?.granted === true, input: call.input, result: call.result }));
    const publications = result.toolCalls.filter((call: any) => call.name === 'publish_interactive_result');
    const successes = publications.filter((call: any) => call.execution.result.status === 'completed');
    const stored = interactive.resultStore.storage.connect(workspaceId, false);
    report.persistedCounts = {
      versions: Number(stored?.db.prepare('SELECT COUNT(*) AS n FROM versions').get().n ?? 0),
      publishedOperations: Number(stored?.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE phase='published'").get().n ?? 0),
    };
    report.firstPublicationSucceeded = scenario === 'publish' ? publications[0]?.execution.result.status === 'completed' : undefined;
    report.naturalRepairCalls = scenario === 'publish' ? Math.max(0, publications.length - 1) : undefined;
    report.fallbackKind = classifyInteractiveFallback(successes.length > 0, result.ok, result.text);
    report.textFallback = report.fallbackKind === 'plain_text_no_publication';
    if (scenario === 'denied') {
      report.approvalDecisions = createApprovalStore({ rootDir: path.join(directory, 'project-runtime') }).list({ workspaceId })
        .map((record: any) => ({ state: record.state, decidedBy: record.decidedBy }));
      report.ok = result.ok && report.approvals === 1 && publications.length === 1 && successes.length === 0
        && publications[0].execution.result.status === 'denied' && report.textFallback === true
        && report.approvalDecisions?.length === 1 && report.approvalDecisions[0].state === 'denied' && report.approvalDecisions[0].decidedBy === 'local_ui'
        && report.persistedCounts.versions === 0 && report.persistedCounts.publishedOperations === 0;
    } else if (successes.length === 1 && result.ok && report.approvals === 0) {
      const fixed = interactive.resultStore.getVersion(successes[0].result.reference);
      report.reference = fixed.reference;
      report.canonicalIndexConfirmed = plans.findEvidenceIndexRecords([fixed.artifactRef]).some((row: any) =>
        row.evidenceRef === fixed.artifactRef && row.userArtifacts?.[0]?.kind === 'interactive');
      report.contentFile = path.join(directory, 'published-content.json');
      writeFileSync(report.contentFile, `${JSON.stringify(fixed.content, null, 2)}\n`, { mode: 0o600 });
      const initial = await runInteractiveValidation({ operation: 'evaluate', content: fixed.content, values: fixed.content.initialValues });
      const changed = await runInteractiveValidation({ operation: 'evaluate', content: fixed.content, values: { ...fixed.content.initialValues, $budget: 80 } });
      const initialElements = elements(initial.tree), changedElements = elements(changed.tree);
      report.computation = {
        initialRemaining: initialElements.filter(item => item.typeName === 'Metric' && item.props.label === 'Remaining').map(item => item.props.value),
        changedRemaining: changedElements.filter(item => item.typeName === 'Metric' && item.props.label === 'Remaining').map(item => item.props.value),
        tableRows: initialElements.filter(item => item.typeName === 'Table').map(item => item.props.rows.length),
        projectionTruncated: initial.projection.truncated || changed.projection.truncated,
      };
      const facts = fixed.content.bindings.facts;
      report.ok = report.canonicalIndexConfirmed === true && Array.isArray(facts) && facts.length === 2
        && facts[0]?.name === 'A' && facts[0]?.cost === 20 && facts[1]?.name === 'B' && facts[1]?.cost === 35
        && fixed.content.initialValues.$budget === 100 && fixed.provenance.every((item: any) => item.source.kind === 'model-data')
        && initialElements.some(item => item.typeName === 'NumberInput' && item.props.label === 'Budget'
          && item.props.min === 0 && item.props.max === 200 && item.props.step === 1)
        && JSON.stringify(report.computation.initialRemaining) === '[45]' && JSON.stringify(report.computation.changedRemaining) === '[25]'
        && JSON.stringify(report.computation.tableRows) === '[2]' && !report.computation.projectionTruncated;
    }
  } catch (error) { report.error = sanitize(error); }
  finally {
    try { await executor?.stop(); await drainTestCleanup(cleanups); }
    catch (error) { report.ok = false; report.error = sanitize(error); }
    finally { interactive?.close(); report.finishedAt = new Date().toISOString(); persist(); }
  }
  return report;
}
