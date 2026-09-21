import { getDesktopPreviewService } from './desktop-preview-service.mjs';
import { resolveChannel } from '../provider-channels.mjs';
import { executeDesktopProviderRequest } from '../chat-runtime/provider-request-coordinator.mjs';
import { createOpenAIVisualObservationMessage, createAnthropicToolResultContent, createGeminiVisualObservationParts, INDEPENDENT_VISUAL_REVIEW_PURPOSE } from '../chat-runtime/visual-observation-projection.mjs';
import { sanitizeApiMessages } from '../chat-runtime/message-sanitizer.mjs';
import { sendOpenAIChatStream } from '../provider-adapters/openai-chat-adapter.mjs';
import { sendOpenAIResponsesStream } from '../provider-adapters/openai-responses-adapter.mjs';
import { sendAnthropicMessagesStream } from '../provider-adapters/anthropic-messages-adapter.mjs';
import { sendGeminiStream } from '../provider-adapters/gemini-adapter.mjs';

const handles = new WeakMap();
const senders = { 'openai-chat': sendOpenAIChatStream, 'openai-responses': sendOpenAIResponsesStream,
  'anthropic-messages': sendAnthropicMessagesStream, gemini: sendGeminiStream };

// Created only by the preview provider after current artifact validation. No IPC
// schema or model tool can mint this object identity. Raw images stay in memory.
export function createDesktopVisualReview({ plan, verifierRunId, workspacePath, goalPlanStore, visual, signal, finish, cancel, recordFailure, reviewToken }) {
  const handle = Object.freeze({});
  handles.set(handle, { plan, verifierRunId, workspacePath, goalPlanStore, visual, signal, finish, cancel, recordFailure, reviewToken, used: false });
  return handle;
}
export function requireDesktopVisualReview(handle, { goalPlanStore, mode, ephemeral, conversationId }) {
  const review = handles.get(handle);
  if (!review || review.used || review.goalPlanStore !== goalPlanStore || mode !== 'explorer'
    || ephemeral !== true || conversationId != null) throw new Error('visual-review-scope');
  review.signal?.throwIfAborted();
  return { workspacePath: review.workspacePath, verifierContext: { planId: review.plan.planId,
    verifierRunId: review.verifierRunId, stage: 'visual', plan: review.plan },
    recordFailure: (reason) => review.recordFailure?.(reason) };
}
export function requireVisualReviewProvider(provider) {
  if (provider?.supportsVision !== true) throw new Error('visual-review-vision-unavailable');
  if (!senders[resolveChannel(provider).wire]) throw new Error('visual-review-wire-unavailable');
}
export function cancelDesktopVisualReview(handle) {
  const review = handles.get(handle);
  if (review) { review.cancel(); handles.delete(handle); }
}

/** Single read-only inference through existing coordinator/encoders/transports.
 * No tool loop, no tool projection, no raw image in UI/persistence, no fallback.
 */
export async function runDesktopVisualReview({ handle, provider, resolvedChannel, apiKey, systemPrompt, streamId, signal }) {
  const review = handles.get(handle);
  if (!review || review.used) throw new Error('visual-review-handle-used');
  review.used = true;
  const combined = AbortSignal.any([signal, review.signal, AbortSignal.timeout(120_000)].filter(Boolean));
  let failedReason = null;
  try {
    combined.throwIfAborted();
    requireVisualReviewProvider(provider);
    const wire = resolvedChannel.wire;
    const send = senders[wire];
    if (!send) throw new Error('visual-review-wire-unavailable');
    if (!getDesktopPreviewService(review.goalPlanStore, review.workspacePath)) throw new Error('visual-review-service-unavailable');
    const result = { output: 'Current governed preview.', visualObservations: [review.visual] };
    const facts = JSON.stringify({ goal: review.plan.goal, title: review.plan.title,
      successCriteria: review.plan.successCriteria ?? [], artifactRef: review.visual.artifactRef,
      scene: review.visual.scene ?? 'application' });
    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: facts }];
    if (wire === 'anthropic-messages') messages.push({ role: 'user', content: createAnthropicToolResultContent(result, INDEPENDENT_VISUAL_REVIEW_PURPOSE) });
    else if (wire === 'gemini') messages.push({ role: 'user', content: 'Current preview image',
      geminiContent: { role: 'user', parts: createGeminiVisualObservationParts([{ result }], INDEPENDENT_VISUAL_REVIEW_PURPOSE) } });
    else messages.push(createOpenAIVisualObservationMessage([{ result }], INDEPENDENT_VISUAL_REVIEW_PURPOSE));
    const execution = await executeDesktopProviderRequest({ request: { messages, systemPrompt,
      contextWindow: provider.contextWindow, providerConfig: { model: provider.model }, signal: combined,
      conversationId: review.plan.conversationId, streamId,
      visualRequestHost: { goalPlanStore: review.goalPlanStore, workspacePath: review.workspacePath, reviewToken: review.reviewToken } },
      // Never summarize an acceptance image away or call an unrelated compactor.
      compactRequest: async () => ({ compacted: false }),
      buildCanonicalRequest: ({ messages: projected }) => ({ messages: sanitizeApiMessages(projected,
        { toolCallFormat: wire === 'gemini' ? 'gemini' : 'openai' }) }),
      send: canonical => send({ ...resolvedChannel, ...canonical, apiKey, systemPrompt,
        headers: resolvedChannel.headers, model: provider.model, tools: [], effort: 'off',
        supportsReasoning: false, streamId, signal: combined, webContents: { send() {} },
        maxOutputTokens: provider.maxOutputTokens, authMethod: resolvedChannel.authMethod,
        projectId: resolvedChannel.oauthProjectId }),
    });
    combined.throwIfAborted();
    return review.finish(execution.response, { goalPlanStore: review.goalPlanStore, workspacePath: review.workspacePath,
      conversationId: review.plan.conversationId, streamId });
  } catch (error) {
    if (typeof error?.message === 'string' && error.message.startsWith('visual-review-')) {
      failedReason = error.message;
    }
    throw error;
  } finally {
    // A deterministic review failure (.e.g non-vision provider) must be surfaced to the
    // authority as a durable 'failed' judgment instead of silently clearing the review;
    // a cancelled verifier (abort) is not a failure and must not erase a real one.
    if (failedReason && typeof review.recordFailure === 'function') {
      try { review.recordFailure(failedReason); } catch { /* best-effort */ }
      handles.delete(handle);
    } else {
      review.cancel();
      handles.delete(handle);
    }
  }
}

export async function runPlanVisualVerifier({ plan, verifierRunId, signal, goalPlanStore, workspacePath,
  llmChatService, modelProviderId }) {
  const provider = getDesktopPreviewService(goalPlanStore, workspacePath);
  if (!provider?.prepareVisualReview) throw new Error('visual-review-service-unavailable');
  const handle = provider.prepareVisualReview(plan.planId, verifierRunId, signal);
  let terminal = null;
  try {
    const outcome = await llmChatService.sendMessage({ messages: [], streamId: verifierRunId,
      mode: 'explorer', ephemeral: true, conversationId: null, workspacePath, modelProviderId,
      visualReviewHandle: handle, webContents: { send(channel, payload) {
        if (['chat:stream:error', 'chat:stream:aborted'].includes(channel)) terminal = payload?.error || channel;
      } } });
    signal?.throwIfAborted();
    if (!outcome?.visualReviewReport) throw new Error(terminal || 'visual-review-no-report');
    return outcome.visualReviewReport;
  } finally { cancelDesktopVisualReview(handle); }
}
