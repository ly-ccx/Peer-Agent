import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { createConversationStore } from '@peer-agent/conversation-store';
import { interactiveFeedbackFromFollowup, restoreResourceFeedbackTransport } from '@peer-agent/protocol';
import { createBotLifecycle, createProjectRegistry, verdictRefFor } from '@peer-agent/runtime-node';
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
  requests: { bot: 28, worker: 12, verifier: 16 }, calls: { bot: 32, worker: 16, verifier: 24 },
  totalRequests: 48, outputTokens: 1800, botOutputTokens: 3200, requestMs: 45_000, caseMs: 360_000,
});
const CAPABILITIES = [
  'local.delegation.spawn_session', 'local.delegation.list_sessions', 'local.delegation.get_session',
  'local.delegation.verify_session', 'local.delegation.get_verification_detail', 'local.delegation.coordinate_work', 'local.delegation.post_reply',
  'local.delegation.wait_for_sessions', 'local.goal.get_plan', 'local.goal.update_task', 'local.interactive.publish', 'local.interactive.inspect',
];
const INITIAL_INPUT = 'live-story-publish', FROZEN_INPUT = 'live-story-verify';
const ASSESSMENT_FORMAT = [
  'For coordinate_work assess, provide reason both at the top level and inside assessment. Copy the exact full IDs and both current revisions from query.',
  'When no prior interpretation is saved, include interpretation with outcome, constraints, nonGoals, openQuestions and requirements. On updates to the same interpretation, preserve requirement IDs.',
  'Each coverage row contains requirementId, status, explanation and sources. Put evidenceRefs only inside each source, alongside its exact sessionId and sourceRevision. Use sources: [] for a remaining requirement with no evidence.',
  'On an event-only wake, use sourceInputIds: [] and inputs: []. Use a wait disposition only while the session is advancing, with the latest observationRevision.',
].join(' ');
const INITIAL_TASK = [
  `Delegate one task with spawn_session exactly once. Reuse the returned session ID after every wake or repair, including after tool errors elsewhere. Use anchorMessageIds ["input-${INITIAL_INPUT}"], kind "research", readOnly true, isolation "none", and requiredCapabilities ["local.interactive.publish"].`,
  'Set successCriteria to [{"kind":"model_review","description":"Independently inspect the program, full facts binding and initial evaluation. Check both costs and the remainder."}]. Keep the longer instructions in brief.',
  'The worker must read its exact plan and task IDs with goal_get_plan, publish once, then use goal_update_task with the returned fixed artifact Evidence. Stop after recording it. Leave inspection to the Verifier.',
  'After spawning, use coordinate_work query with the current workId. Before post_reply, persist an assess decision with the exact current work and goal revisions, source IDs, input disposition, and evidence coverage. If the session is still running, wait on its current observation revision. Otherwise handle the current result. The reply alone does not record a disposition.',
  ASSESSMENT_FORMAT,
  'The assessment has two substantive requirements: publish and record the fixed example, and independently verify the example. An acknowledgment, post_reply, or later user interaction is not an evidence requirement. Do not add it to coverage or openQuestions. When returning the verified example, record the return disposition with replyRef "current_turn_reply" and send post_reply with replyTo ["input-live-story-publish"], the complete session ID in sources, and its current status in statusClaims.',
  'No further user input or human acceptance is needed for this request. While the worker is still advancing, wait on the current session instead of posting a progress-only reply. When it finishes, read the current host verification and cite its indexed evidence for the checks it covers. Keep the original result and do not claim human acceptance.',
  'Worker brief: ' + INTERACTIVE_LIVE_TASK,
].join('\n');
const FROZEN_TASK = [
  'The selected budget has already been supplied in the attached frozen selection. Do not ask me to supply it again or restate an earlier progress reply.',
  `Delegate this new request via spawn_session exactly once. Reuse its returned session ID on subsequent turns, including during repair. Use anchorMessageIds ["input-${FROZEN_INPUT}"] to carry the attached frozen selection. Set kind "research", readOnly true, isolation "none", and requiredCapabilities ["local.interactive.inspect"].`,
  'The new worker should use goal_get_plan, then inspect the attached fixed result once with view evaluate and the attached followupId, then record that actual result and evidence on its leaf with goal_update_task. Keep the worker brief limited to that one inspection. Put the four independent checks only in successCriteria.',
  'Set successCriteria to [{"kind":"model_review","description":"Independently inspect the attached fixed result in four calls together: program, data binding facts, initial evaluate, and evaluate with the attached followupId. Cite only the four canonical interactive-inspection references."}].',
  'After spawning, acknowledge this input once through post_reply with replyTo ["input-live-story-verify"]. Report only that the delegated check is underway. On background wakes, if the follow-up session is running or verifying, end the wake with wait_for_sessions using its sessionIds list. Do not assess a wait for a session that has left its waitable state. If a wait is stale, use the current returned status before deciding what to do.',
  'For this new frozen selection I request a fresh, formal independent review. Once the follow-up session reaches result_ready or accepted and automatic review is idle, call verify_session with focus on the four checks in its success criteria. A read-only get_verification_detail summary may show passed from the automatic review. If verify_session reports verifier_in_progress, end the background wake with wait_for_sessions while the review is active. Reuse the original publication review.',
  ASSESSMENT_FORMAT,
  'Use the new session’s indexed inspection evidence for this work’s coverage. Cite the earlier publication separately in the final reply. Deliver via the return disposition with replyRef "current_turn_reply". Then use post_reply with replyTo ["input-live-story-verify"], both session IDs as sources and their current statuses. Explain the two remainders, describe the costs as synthetic, and state the actual verification and human acceptance status. Do not republish or substitute direct Bot inspection for delegation.',
].join('\n');

type Phase = keyof typeof INTERACTIVE_STORY_BUDGET.requests;
interface Observation {
  phase: Phase;
  tools: string[];
  returnedTools?: string[];
  returnedArguments?: string[];
  durationMs?: number;
  usage?: ModelUsage;
  diagnostic?: 'no_usable_output_at_token_limit' | 'request_deadline';
  error?: string;
}

export async function runInteractiveLiveStory(options: {
  directory: string; provider: ModelProvider; model: { providerId: string; credentialId: string; model: string };
  sanitize: (value: unknown) => string; onProgress?: (report: { requests: Observation[]; finishedAt?: string }) => void;
}) {
  const { directory, model, sanitize } = options;
  mkdirSync(directory, { mode: 0o700 });
  const report: { ok: boolean; scenario: 'story'; startedAt: string; finishedAt?: string; stage: string; error?: string;
    requests: Observation[];
    budgetExhausted?: { scope: 'story' | 'role'; resource: 'requests' | 'toolCalls'; phase: Phase; used: number; limit: number };
    publication?: unknown; initialReply?: unknown; frozen?: unknown; frozenInput?: unknown; sessions?: unknown; verification?: unknown; receipts?: unknown; replies?: unknown; delivery?: unknown } = {
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
    let budgetError: Error | undefined;
    function exhausted(scope: 'story' | 'role', resource: 'requests' | 'toolCalls', phase: Phase, used: number, limit: number): never {
      report.budgetExhausted ??= { scope, resource, phase, used, limit };
      const code = resource === 'toolCalls' ? 'story_tool_limit' : scope === 'story' ? 'story_total_request_limit' : 'story_request_limit';
      budgetError ??= new Error(`${code}:${phase}`);
      throw budgetError;
    }
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
          if (report.requests.length >= INTERACTIVE_STORY_BUDGET.totalRequests)
            exhausted('story', 'requests', phase, report.requests.length, INTERACTIVE_STORY_BUDGET.totalRequests);
          if (prior.length >= INTERACTIVE_STORY_BUDGET.requests[phase])
            exhausted('role', 'requests', phase, prior.length, INTERACTIVE_STORY_BUDGET.requests[phase]);
          const observation: Observation = { phase, tools: names };
          report.requests.push(observation);
          const start = Date.now();
          const requestDeadline = AbortSignal.timeout(INTERACTIVE_STORY_BUDGET.requestMs);
          try {
            // The coordinator must fit a complete assessment and its evidence references.
            const maxOutputTokens = phase === 'bot' ? INTERACTIVE_STORY_BUDGET.botOutputTokens : INTERACTIVE_STORY_BUDGET.outputTokens;
            const result = await options.provider.stream({ ...request, maxOutputTokens,
              signal: AbortSignal.any([signal, requestDeadline, ...(request.signal ? [request.signal] : [])]) });
            observation.usage = result.usage;
            if (!result.content.trim() && !result.toolCalls.length && (result.usage?.outputTokens ?? 0) >= maxOutputTokens)
              observation.diagnostic = 'no_usable_output_at_token_limit';
            observation.returnedTools = result.toolCalls.map(call => call.name);
            observation.returnedArguments = result.toolCalls.slice(0, 12).map(call => sanitize(call.arguments));
            callCounts[phase] += result.toolCalls.length;
            if (callCounts[phase] > INTERACTIVE_STORY_BUDGET.calls[phase])
              exhausted('role', 'toolCalls', phase, callCounts[phase], INTERACTIVE_STORY_BUDGET.calls[phase]);
            return result;
          } catch (error) {
            if (requestDeadline.aborted && !signal.aborted && !request.signal?.aborted)
              observation.diagnostic = 'request_deadline';
            observation.error = sanitize(error);
            throw error;
          }
          finally { observation.durationMs = Date.now() - start; persist(); }
        } };
        return createTurnTestRuntime({ host: tools,
          modelSelection: createTuiModelSelectionControl({ providerId: model.credentialId, modelId: model.model, displayName: model.model }),
          model: createProviderChatModel({ model: model.model, provider: observed, streamRetryDelaysMs: [],
            toolArtifactBaseDir: path.join(directory, 'artifacts'),
            toolDefinitionsForMode: mode => tools.toolDefinitionsForMode!(mode),
            getSystemPrompt: context => buildTuiSystemPrompt({}, { ...context.systemContextInput, mode: context.mode }) }) }, cleanups);
      },
    });
    let tickError: unknown;
    let activeTicks = 0;
    function tick(foregroundInput = false) {
      if (activeTicks && !foregroundInput) return;
      activeTicks += 1;
      void host.tick().catch(error => { tickError = error; }).finally(() => { activeTicks -= 1; });
    }
    function storySources() {
      const sessions = host.supervisor.sessionsForProject(workspaceId);
      const byInput = (id: string) => sessions.filter(session =>
        host.plans.getPlan(session.planId)?.delegationOrigin?.anchorMessageId === `input-${id}`);
      if (byInput(INITIAL_INPUT).length > 1) throw Error('story_duplicate_initial_delegation');
      const followups = byInput(FROZEN_INPUT);
      if (followups.length > 1) throw Error('story_duplicate_followup');
      const publications = host.plans.listEvidenceIndex().filter((row: any) =>
        row.capabilityId === 'local.interactive.publish' && row.userArtifacts?.[0]?.kind === 'interactive'
        && row.evidenceRef === row.userArtifacts[0].ref);
      if (publications.length > 1) throw Error('story_duplicate_publication');
      return { sessions, followups, publication: publications[0] };
    }
    async function waitFor<T>(read: (sources: ReturnType<typeof storySources>) => T | undefined): Promise<T> {
      while (!signal.aborted) {
        if (tickError) throw tickError;
        tick();
        const value = read(storySources());
        if (value !== undefined) return value;
        if (budgetError) throw budgetError;
        try { await delay(100, undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
      }
      throw Error('story_deadline');
    }
    let submittedFeedback: ReturnType<typeof interactiveFeedbackFromFollowup>;
    function readFrozenInput() {
      if (!submittedFeedback) return;
      const message = host.conversations.getPersistedConversationHistory!(conversationId)?.messages
        .find(row => row.id === `input-${FROZEN_INPUT}`);
      if (!message) return;
      const [feedback, extra] = restoreResourceFeedbackTransport(message.resourceFeedback,
        Array.isArray(message.attachments) ? message.attachments : undefined);
      if (!feedback || extra || !isDeepStrictEqual(feedback, submittedFeedback))
        throw Error('story_canonical_frozen_input_mismatch');
      return { messageId: message.id, feedback };
    }
    try {
      report.stage = 'delegation-and-publication';
      persist();
      host.inputs.submitInput({ workspaceId, inputId: INITIAL_INPUT, text: INITIAL_TASK, surface: 'tui' });
      const publication = await waitFor(({ publication: row }) => {
        const artifact = row?.userArtifacts?.[0];
        if (!artifact) return;
        const plan = host.plans.getPlan(row.planId);
        const session = plan?.delegationOrigin?.sessionId
          ? host.supervisor.get({ sessionId: plan.delegationOrigin.sessionId, detail: 'summary' }) : undefined;
        if (session?.status !== 'result_ready' && session?.status !== 'accepted') return;
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
      report.stage = 'initial-delivery';
      persist();
      const initialReply = await waitFor(() => {
        const history = host.conversations.getPersistedConversationHistory!(conversationId)?.messages ?? [];
        return history.find((message: any) => message.kind === 'agent_reply' && message.fallback !== true
          && message.meta?.replyTo?.includes(`input-${INITIAL_INPUT}`)
          && message.meta?.sessionStates?.some((source: { sessionId: string; status: string }) =>
            source.sessionId === fixed.source.sessionId && (source.status === 'result_ready' || source.status === 'accepted'))
          && message.meta?.evidenceRefs?.includes(fixed.artifactRef));
      });
      report.initialReply = { messageId: initialReply.id, createdAt: initialReply.createdAt, meta: initialReply.meta };
      report.stage = 'frozen-input';
      persist();
      const { stateStore } = host.interactive, current = () => host.holdsLease(workspaceId);
      const identity = { viewId: 'story-view', windowId: 'story-window', generation: 'story-generation' };
      const state = stateStore.read(fixed.reference, current);
      const writer = stateStore.acquire({ reference: fixed.reference, identity, expectedRevision: state.stateRevision }, current);
      let frozenVersion: Extract<NonNullable<typeof submittedFeedback>['version'], { kind: 'interactive' }>;
      try {
        const saved = stateStore.save({ reference: fixed.reference, identity, writer, expectedRevision: state.stateRevision,
          requestId: 'story-save', values: { ...fixed.content.initialValues, $budget: 80 }, inputDrafts: {} }, current);
        const frozen = await stateStore.prepareFollowup({ reference: fixed.reference, identity, writer,
          requestId: 'story-freeze', stateRevision: saved.stateRevision, stateDigest: saved.stateDigest, fields: ['$budget'] }, current);
        const feedback = interactiveFeedbackFromFollowup(frozen);
        if (!feedback || feedback.version.kind !== 'interactive') throw Error('story_feedback_invalid');
        host.inputs.submitInput({ workspaceId, inputId: FROZEN_INPUT, text: FROZEN_TASK, resourceFeedback: [feedback], surface: 'tui' });
        // The TUI submission path notifies the host even while a wake is active.
        tick(true);
        submittedFeedback = feedback;
        frozenVersion = feedback.version;
        report.frozen = feedback;
      } finally { stateStore.release({ reference: fixed.reference, identity, writer }, current); }
      report.stage = 'verification-and-reply';
      persist();
      let lastReview: string | undefined;
      let covered = new Set<string>();
      const delivered = await waitFor(({ sessions, followups }) => {
        if (!report.frozenInput) {
          report.frozenInput = readFrozenInput();
          if (report.frozenInput) persist();
        }
        if (!report.frozenInput) return;
        const verification = followups[0];
        const plan = verification && host.plans.getPlan(verification.planId);
        const verdict = plan?.hostVerification;
        if (!verification || verdict?.verdictRef !== verdictRefFor(verification.sessionId, 'passed')
          || verdict.independentVerifier !== 'passed') return;
        const review = plan?.runner?.verifierRuns?.findLast((run: { verifierRunId: string }) =>
          run.verifierRunId.startsWith('delegated-semantic:'));
        if (review?.status !== 'passed' || !review.completedAt || !review.evidenceRefs?.length) return;
        const reviewKey = JSON.stringify([review.verifierRunId, review.completedAt, review.evidenceRefs]);
        if (reviewKey !== lastReview) {
          const reviewRefs = new Set(review.evidenceRefs);
          const receipts = host.plans.listEvidenceIndex().filter((row: any) =>
            row.planId === verification.planId && reviewRefs.has(row.evidenceRef) && row.interactiveInspection);
          covered = new Set(receipts.flatMap((row: any) => {
            const receipt = row.interactiveInspection, { request, range, stateSource } = receipt;
            if (request.target.kind !== 'result' || !isDeepStrictEqual(request.target.reference, fixed.reference)
              || range?.truncated !== false || range.offset !== 0 || range.returned !== range.total || receipt.computationTruncated) return [];
            if (request.view === 'program') return ['program'];
            if (request.view === 'data' && request.bindingId === 'facts') return ['facts'];
            if (request.view === 'evaluate' && stateSource?.kind === 'initial') return ['initial'];
            return request.view === 'evaluate' && stateSource?.kind === 'frozen-followup'
              && stateSource.followupId === frozenVersion.followupId && stateSource.stateRevision === frozenVersion.stateRevision
              && stateSource.stateDigest === frozenVersion.stateDigest && stateSource.selectionDigest === frozenVersion.selectionDigest
              ? ['frozen'] : [];
          }));
          report.receipts = receipts;
          report.verification = { sessionId: verification.sessionId, planId: verification.planId,
            verdictRef: verdict.verdictRef, verifierRunId: review.verifierRunId, completedAt: review.completedAt, covered: [...covered] };
          lastReview = reviewKey;
          persist();
        }
        const history = host.conversations.getPersistedConversationHistory!(conversationId)?.messages ?? [];
        const reply = history.filter((message: any) => message.kind === 'agent_reply' && message.fallback !== true
          && Date.parse(message.createdAt) >= Date.parse(review.completedAt)
          && message.meta?.replyTo?.includes(`input-${FROZEN_INPUT}`) && message.meta?.evidenceRefs?.includes(fixed.artifactRef)
          && message.meta?.sources?.includes(fixed.source.sessionId) && message.meta?.sources?.includes(verification.sessionId)
          && /\b45\b/.test(message.content) && /\b25\b/.test(message.content)).at(-1);
        return reply ? { sessions, reply, covered } : undefined;
      });
      report.sessions = delivered.sessions;
      report.replies = [delivered.reply];
      if (delivered.covered.size !== 4) throw Error('story_verifier_evidence_incomplete');
      const delivery = await host.readTaskResult(fixed.source.sessionId, fixed.artifactRef, signal);
      if (delivery.summary.availability !== 'available' || !delivery.computation
        || delivery.computation.truncated || !/\b45\b/.test(delivery.computation.text)) throw Error('story_text_delivery_incomplete');
      storySources();
      report.delivery = delivery;
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
