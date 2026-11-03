import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConversationStore } from '@peer-agent/conversation-store';
import { interactiveFeedbackFromFollowup } from '@peer-agent/protocol';
import { createBotLifecycle, createProjectRegistry } from '@peer-agent/runtime-node';
import type { ModelProvider, ModelUsage } from '@peer-agent/runtime-node/models';
import { restrictTuiHostTools } from '../cli-host-filter.ts';
import { createProviderChatModel } from '../provider-chat-model.ts';
import { createTuiHost } from '../tui-host.ts';
import { buildTuiSystemPrompt } from '../tui-language.ts';
import { createTuiModelSelectionControl } from '../tui-model-selection.ts';
import { INTERACTIVE_LIVE_TASK } from './interactive-live-validation.ts';
import { createTuiProjectHost } from './tui-project-host.ts';
import { createTurnTestRuntime, drainTestCleanup, type TestCleanup } from './turn-test-support.ts';

export const INTERACTIVE_STORY_BUDGET = Object.freeze({
  requests: { bot: 16, worker: 10, verifier: 10 }, calls: { bot: 24, worker: 14, verifier: 18 },
  totalRequests: 32, outputTokens: 1800, requestMs: 45_000, caseMs: 240_000,
});
const CAPABILITIES = [
  'local.delegation.spawn_session', 'local.delegation.list_sessions', 'local.delegation.get_session',
  'local.delegation.verify_session', 'local.delegation.get_verification_detail', 'local.delegation.coordinate_work', 'local.delegation.post_reply',
  'local.goal.get_plan', 'local.goal.update_task', 'local.interactive.publish', 'local.interactive.inspect',
];
const INITIAL_INPUT = 'live-story-publish', FROZEN_INPUT = 'live-story-verify';
const INITIAL_TASK = 'Delegate one read-only research session for the following example. Declare local.interactive.publish and a model_review criterion for the fixed program and its two rows. Use the current input anchor. The worker should use goal_get_plan to learn the leaf task and mark it complete with the actual published interactive artifact Evidence. When the result is available, I will send a second input with selected conditions. Keep the original result and do not declare human acceptance. Worker brief: ' + INTERACTIVE_LIVE_TASK;
const FROZEN_TASK = 'Use this attached frozen budget selection to check the same saved result. Delegate a new read-only research session from this exact current input anchor. It must use the selected result without publishing another version. Declare local.interactive.inspect and a model_review criterion requiring program, complete facts binding, initial evaluation and attached frozen evaluation. The worker should inspect the fixed result and report actual inspection Evidence on its goal task. Ask the independent Verifier to inspect program, data binding facts, initial evaluation and frozen evaluation using the attachment followupId. Its JSON evidenceRefs must contain the four canonical interactive-inspection references. In your final post_reply cite both the original publication session and the independently verified follow-up session. Include the two calculated remainders, distinguish model-constructed inputs from verified arithmetic and avoid any claim of human acceptance.';

type Phase = keyof typeof INTERACTIVE_STORY_BUDGET.requests;
interface Observation { phase: Phase; tools: string[]; returnedTools?: string[]; durationMs?: number; usage?: ModelUsage; error?: string }

export async function runInteractiveLiveStory(options: {
  directory: string; provider: ModelProvider; model: { providerId: string; credentialId: string; model: string };
  sanitize: (value: unknown) => string; onProgress?: (report: { requests: Observation[]; finishedAt?: string }) => void;
}) {
  const { directory, model, sanitize } = options;
  mkdirSync(directory, { mode: 0o700 });
  const report: { ok: boolean; scenario: 'story'; startedAt: string; finishedAt?: string; stage: string; error?: string;
    requests: Observation[]; publication?: unknown; frozen?: unknown; sessions?: unknown; receipts?: unknown; replies?: unknown; delivery?: unknown } = {
    ok: false, scenario: 'story', startedAt: new Date().toISOString(), stage: 'setup', requests: [],
  };
  const persist = () => {
    writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    options.onProgress?.(report);
  };
  const signal = AbortSignal.timeout(INTERACTIVE_STORY_BUDGET.caseMs);
  const cleanups: TestCleanup[] = [];
  try {
    const workspacePath = path.join(directory, 'workspace');
    mkdirSync(workspacePath);
    const provider = { id: model.credentialId, provider: model.providerId, model: model.model, enabled: true,
      apiKeyConfigured: true, supportsTools: true, supportsStructured: true, isDefault: true };
    writeFileSync(path.join(directory, 'llm-providers.json'), JSON.stringify([provider]), { mode: 0o600 });
    const registry = createProjectRegistry({ filePath: path.join(directory, 'projects/registry.json') });
    const { workspaceId } = registry.ensureForPath(workspacePath);
    const conversations = createConversationStore({ storeDir: path.join(directory, 'conversations') });
    const lifecycle = createBotLifecycle({ rootDir: directory, registry, conversationStore: conversations } as never);
    const created = lifecycle.ensureBot(workspaceId) as any;
    if (!created.ok) throw Error('story_bot_unavailable');
    const conversationId: string = created.profile.agentConversationId;
    const callCounts = { bot: 0, worker: 0, verifier: 0 };
    const host = createTuiProjectHost({ dataHome: directory, workspacePath, autoStart: false,
      getSettings: () => ({ providers: [provider], localAccessLevel: 'full_local',
        projectAgent: { interactiveResults: true, concurrency: 2 }, memory: { enabled: false } }),
      createRuntime(runtimeOptions) {
        const tools = restrictTuiHostTools(createTuiHost(runtimeOptions), CAPABILITIES);
        const observed: ModelProvider = { async stream(request) {
          const names = request.tools?.map(tool => tool.name) ?? [];
          const phase: Phase = names.includes('spawn_session') ? 'bot'
            : request.messages.some(row => typeof row.content === 'string' && row.content.includes('Verifier mission for plan')) ? 'verifier' : 'worker';
          const prior = report.requests.filter(row => row.phase === phase);
          if (prior.length >= INTERACTIVE_STORY_BUDGET.requests[phase]
            || report.requests.length >= INTERACTIVE_STORY_BUDGET.totalRequests) throw Error('story_request_limit');
          const observation: Observation = { phase, tools: names };
          report.requests.push(observation);
          const start = Date.now();
          try {
            const result = await options.provider.stream({ ...request, maxOutputTokens: INTERACTIVE_STORY_BUDGET.outputTokens,
              signal: AbortSignal.any([signal, AbortSignal.timeout(INTERACTIVE_STORY_BUDGET.requestMs), ...(request.signal ? [request.signal] : [])]) });
            observation.usage = result.usage;
            observation.returnedTools = result.toolCalls.map(call => call.name);
            callCounts[phase] += result.toolCalls.length;
            if (callCounts[phase] > INTERACTIVE_STORY_BUDGET.calls[phase])
              throw Error('story_tool_limit');
            return result;
          } catch (error) { observation.error = sanitize(error); throw error; }
          finally { observation.durationMs = Date.now() - start; persist(); }
        } };
        return createTurnTestRuntime({ host: tools,
          modelSelection: createTuiModelSelectionControl({ providerId: model.credentialId, modelId: model.model, displayName: model.model }),
          model: createProviderChatModel({ model: model.model, provider: observed, streamRetryDelaysMs: [],
            toolDefinitionsForMode: mode => tools.toolDefinitionsForMode!(mode),
            getSystemPrompt: context => buildTuiSystemPrompt({}, { ...context.systemContextInput, mode: context.mode }) }) }, cleanups);
      },
    });
    let tickError: unknown;
    let ticking = false;
    function tick() {
      if (ticking) return;
      ticking = true;
      void host.tick().catch(error => { tickError = error; }).finally(() => { ticking = false; });
    }
    async function waitFor<T>(read: () => T | undefined): Promise<T> {
      while (!signal.aborted) {
        if (tickError) throw tickError;
        tick();
        const value = read();
        if (value !== undefined) return value;
        await delay(100, undefined, { signal });
      }
      throw Error('story_deadline');
    }
    try {
      report.stage = 'delegation-and-publication';
      persist();
      host.inputs.submitInput({ workspaceId, inputId: INITIAL_INPUT, text: INITIAL_TASK, surface: 'tui' });
      const publication = await waitFor(() => {
        const rows = host.plans.listEvidenceIndex().filter((row: any) => row.capabilityId === 'local.interactive.publish' && row.userArtifacts?.[0]?.kind === 'interactive' && row.evidenceRef === row.userArtifacts[0].ref);
        if (rows.length > 1) throw Error('story_duplicate_publication');
        const row = rows[0], artifact = row?.userArtifacts?.[0];
        if (!artifact) return;
        const plan = host.plans.getPlan(row.planId);
        if (!plan?.tasks.some((task: any) => task.status === 'completed'
          && task.evidenceRefs?.some((ref: string) => ref === row.evidenceRef || ref === `tool-result://${row.toolCallId}`))) return;
        return { row, fixed: host.interactive.resultStore.getVersion(artifact.reference) };
      });
      const { fixed } = publication;
      const origin = host.plans.getPlan(fixed.source.planId)?.delegationOrigin;
      const facts = fixed.content.bindings.facts;
      if (origin?.anchorMessageId !== `input-${INITIAL_INPUT}` || origin.readOnly !== true
        || fixed.content.initialValues.$budget !== 100 || !Array.isArray(facts) || facts.length !== 2
        || facts[0]?.name !== 'A' || facts[0]?.cost !== 20 || facts[1]?.name !== 'B' || facts[1]?.cost !== 35)
        throw Error('story_publication_mismatch');
      report.publication = { evidenceRef: publication.row.evidenceRef, reference: fixed.reference, source: fixed.source };
      report.stage = 'frozen-input';
      const { stateStore } = host.interactive, current = () => host.holdsLease(workspaceId);
      const identity = { viewId: 'story-view', windowId: 'story-window', generation: 'story-generation' };
      const state = stateStore.read(fixed.reference, current);
      const writer = stateStore.acquire({ reference: fixed.reference, identity, expectedRevision: state.stateRevision }, current);
      let followupId: string;
      try {
        const saved = stateStore.save({ reference: fixed.reference, identity, writer, expectedRevision: state.stateRevision,
          requestId: 'story-save', values: { ...fixed.content.initialValues, $budget: 80 }, inputDrafts: {} }, current);
        const frozen = await stateStore.prepareFollowup({ reference: fixed.reference, identity, writer,
          requestId: 'story-freeze', stateRevision: saved.stateRevision, stateDigest: saved.stateDigest, fields: ['$budget'] }, current);
        const feedback = interactiveFeedbackFromFollowup(frozen);
        if (!feedback) throw Error('story_feedback_invalid');
        host.inputs.submitInput({ workspaceId, inputId: FROZEN_INPUT, text: FROZEN_TASK, resourceFeedback: [feedback], surface: 'tui' });
        followupId = feedback.id;
        report.frozen = feedback;
      } finally { stateStore.release({ reference: fixed.reference, identity, writer }, current); }
      report.stage = 'verification-and-reply';
      const delivered = await waitFor(() => {
        const sessions = host.supervisor.sessionsForProject(workspaceId);
        const verification = sessions.find((session: any) => session.sessionId !== fixed.source.sessionId
          && host.plans.getPlan(session.planId)?.delegationOrigin?.anchorMessageId === `input-${FROZEN_INPUT}`
          && host.plans.getPlan(session.planId)?.hostVerification?.independentVerifier === 'passed');
        const history = host.conversations.getPersistedConversationHistory!(conversationId)?.messages ?? [];
        if (!verification || !history.some(message => message.id === `input-${FROZEN_INPUT}`)) return;
        const reply = history.filter((message: any) => message.kind === 'agent_reply' && message.meta?.evidenceRefs?.includes(fixed.artifactRef)
          && message.meta?.sources?.includes(fixed.source.sessionId) && message.meta?.sources?.includes(verification.sessionId)
          && /\b45\b/.test(message.content) && /\b25\b/.test(message.content)).at(-1);
        return verification && reply ? { sessions, verification, reply } : undefined;
      });
      report.sessions = delivered.sessions;
      report.replies = [delivered.reply];
      const receipts = host.plans.listEvidenceIndex().filter((row: any) => row.planId === delivered.verification.planId && row.interactiveInspection);
      report.receipts = receipts;
      const covered = new Set(receipts.flatMap((row: any) => {
        const receipt = row.interactiveInspection, { request, range, stateSource } = receipt;
        if (request.target.kind !== 'result' || JSON.stringify(request.target.reference) !== JSON.stringify(fixed.reference)
          || range?.truncated || range?.offset !== 0 || receipt.computationTruncated) return [];
        if (request.view === 'program') return ['program'];
        if (request.view === 'data' && request.bindingId === 'facts') return ['facts'];
        if (request.view === 'evaluate' && stateSource?.kind === 'initial') return ['initial'];
        return request.view === 'evaluate' && stateSource?.followupId === followupId ? ['frozen'] : [];
      }));
      if (covered.size !== 4) throw Error('story_verifier_evidence_incomplete');
      report.delivery = await host.readTaskResult(fixed.source.sessionId, fixed.artifactRef, signal);
      report.stage = 'delivered';
      report.ok = true;
    } finally {
      report.sessions ??= host.supervisor.sessionsForProject(workspaceId);
      await host.close();
    }
  } catch (error) { report.error = sanitize(error); }
  finally {
    try { await drainTestCleanup(cleanups); }
    catch (error) { report.ok = false; report.error = sanitize(error); }
    report.finishedAt = new Date().toISOString();
    persist();
  }
  return report;
}
