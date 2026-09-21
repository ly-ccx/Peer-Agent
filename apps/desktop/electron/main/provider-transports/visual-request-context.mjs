import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { snapshotVisualResponse, inspectVisualJudgmentCandidate } from '../runtime-gateway/visual-judgment-candidate.mjs';
import { collectProjectedPreviewObservations, desktopPreviewObservationSource,
  getDesktopPreviewService } from '../runtime-gateway/desktop-preview-service.mjs';
import { encodedVisualImageHashes, hashVisualBytes, visualDataUrlHash } from '../provider-encoders/visual-request-images.mjs';

const requests = new AsyncLocalStorage();
const adapters = new AsyncLocalStorage();
const verifiedResponses = new WeakMap();

// One-use host proof, never reconstructed from receipt JSON or model text.
export function consumeVerifiedVisualResponse(response, scope) {
  const proof = verifiedResponses.get(response);
  if (!proof || ['goalPlanStore', 'workspacePath', 'conversationId', 'streamId', 'reviewToken'].some(key => proof[key] !== scope[key])) {
    throw new Error('visual-review-response-unbound');
  }
  verifiedResponses.delete(response);
  proof.signal?.throwIfAborted();
  proof.validate();
  if (snapshotVisualResponse(response, proof.wire).responseHash !== proof.responseHash) throw new Error('visual-review-response-changed');
  return { modelRunId: proof.modelRunId, requestId: proof.requestId, observations: proof.observations,
    text: proof.text, candidate: proof.candidate, responseHash: proof.responseHash };
}

/** Desktop adapter seam, not a model-visible setter. Identity stays in this send.
 * A cloned, altered, nested, or earlier response cannot claim the final attempt.
 */
export function trackVisualAdapterResponse(wire, options, invoke) {
  const context = requests.getStore();
  if (!context?.active) return invoke();
  if (options.model !== context.model || options.streamId !== context.streamId) {
    throw new Error('visual-request-adapter-mismatch');
  }
  const adapter = { context, wire, attempts: [], active: true };
  return adapters.run(adapter, async () => {
    try {
      const response = await invoke();
      context.signal?.throwIfAborted();
      options.signal?.throwIfAborted();
      if (context.active && response && typeof response === 'object') {
        context.responses.set(response, { wire, attempt: adapter.attempts.at(-1),
          snapshot: snapshotVisualResponse(response, wire) });
      }
      return response;
    } finally { adapter.active = false; }
  });
}

function responseBinding(context, response, status) {
  if (status !== 'response-completed') return { status: 'unbound', reason: 'request-incomplete' };
  const binding = response && typeof response === 'object' ? context.responses.get(response) : null;
  if (!binding) return { status: 'unbound', reason: 'untracked-response' };
  if (!binding.attempt || binding.attempt !== context.attempts.at(-1)
    || !binding.attempt.imagesPresent || !binding.attempt.httpOk) {
    return { status: 'unbound', reason: 'attempt-mismatch' };
  }
  if (snapshotVisualResponse(response, binding.wire).responseHash !== binding.snapshot.responseHash) {
    return { status: 'unbound', reason: 'response-changed' };
  }
  return { status: 'bound', wire: binding.wire, attemptId: binding.attempt.attemptId,
    responseHash: binding.snapshot.responseHash,
    candidate: inspectVisualJudgmentCandidate(binding.snapshot, context.observations) };
}
/** Scope one adapter invocation, including transport retries, to local sources.
 * Never treat a textual ref or replayed JSON as provenance. No new network path.
 */
export function createVisualRequestScope({ messages, goalPlanStore, workspacePath, conversationId, streamId, model, signal, reviewToken }) {
  const visuals = collectProjectedPreviewObservations(messages);
  if (!visuals.length) return { send: invoke => requests.run(null, invoke) };
  if (reviewToken == null) throw new Error('visual-request-review-pending');
  const provider = getDesktopPreviewService(goalPlanStore, workspacePath);
  if (!provider) throw new Error('visual-request-service-unavailable');
  const sources = visuals.map(visual => {
    const source = desktopPreviewObservationSource(visual);
    if (source?.goalPlanStore !== goalPlanStore || source?.conversationId !== conversationId
      || getDesktopPreviewService(source.goalPlanStore, source.workspaceRoot) !== provider) {
      throw new Error('visual-request-scope-mismatch');
    }
    return { visual, source };
  });
  const validate = () => sources.map(({ visual, source }) => {
    if (getDesktopPreviewService(goalPlanStore, workspacePath) !== provider) {
      throw new Error('visual-request-service-unavailable');
    }
    const stored = provider.validateVisualSource(visual, source);
    if (visualDataUrlHash(visual.dataUrl) !== stored.artifactHash) throw new Error('visual-request-image-mismatch');
    // Deliberate allowlist: never persist prompts, image bytes, response text or credentials.
    return Object.fromEntries(['planId', 'conversationId', 'workspacePath', 'artifactRef', 'artifactHash',
      'evidenceRef', 'toolCallId', 'instanceId', 'buildFingerprint', 'sourceFingerprint', 'requirementRevision', 'scene']
      .map(key => [key, stored[key]]));
  });
  return {
    async send(invoke) {
      signal?.throwIfAborted();
      const observations = validate();
      const modelRunId = randomUUID();
      const receipt = provider.requestReceipts.start({ streamId, model, modelRunId, observations });
      const context = { receipt, observations, validate, streamId, model, signal,
        responses: new WeakMap(), attempts: [], active: true };
      return requests.run(context, async () => {
        try {
          const response = await invoke();
          signal?.throwIfAborted();
          validate();
          const status = response?.ok === true && !response.streamError && !response.providerError
            ? (context.attempts.at(-1)?.imagesPresent && context.attempts.at(-1)?.httpOk
              ? 'response-completed' : 'image-not-transported') : 'response-failed';
          const binding = responseBinding(context, response, status);
          receipt.finish(status, binding);
          if (binding.status === 'bound') verifiedResponses.set(response, {
            goalPlanStore, workspacePath, conversationId, streamId, modelRunId, reviewToken,
            requestId: receipt.requestId, signal, validate, observations,
            ...binding, text: context.responses.get(response).snapshot.text,
          });
          return response;
        } catch (error) {
          receipt.finish(signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed');
          throw error;
        } finally { context.active = false; }
      });
    },
  };
}

/** Called at each actual fetch attempt, after encoding/rebuilding the request. */
export async function observeVisualTransportAttempt(init, { provider: wire, model, streamId }, invoke) {
  const context = requests.getStore();
  if (!context?.active) return invoke();
  if (context.model !== model || context.streamId !== streamId) throw new Error('visual-request-transport-mismatch');
  context.signal?.throwIfAborted();
  init.signal?.throwIfAborted();
  context.validate();
  const hashes = encodedVisualImageHashes(init.body, wire);
  const imagesPresent = context.observations.every(observation => hashes.has(observation.artifactHash));
  const attempt = { attemptId: randomUUID(), imagesPresent, httpOk: false };
  const finish = context.receipt.attempt({ attemptId: attempt.attemptId, wire, model, imagesPresent,
    bodyHash: typeof init.body === 'string' ? hashVisualBytes(init.body) : null });
  context.attempts.push(attempt);
  const adapter = adapters.getStore();
  if (adapter?.active && adapter.context === context && adapter.wire === wire) adapter.attempts.push(attempt);
  try {
    const response = await invoke();
    context.signal?.throwIfAborted();
    init.signal?.throwIfAborted();
    attempt.httpOk = response.ok === true;
    finish({ status: response.ok ? 'http-response' : 'http-error', httpStatus: response.status });
    return response;
  } catch (error) {
    finish({ status: context.signal?.aborted || init.signal?.aborted || error?.name === 'AbortError'
      ? 'cancelled' : 'transport-failed' });
    throw error;
  }
}
