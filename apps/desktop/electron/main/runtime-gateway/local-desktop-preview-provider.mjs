import { createHash, randomUUID } from 'node:crypto';
import { createDesktopPreviewArtifactStore, readPreviewFile, artifactIdFromRef } from './desktop-preview-artifacts.mjs';
import { createDesktopVisualReview } from './desktop-visual-review.mjs';
import { DESKTOP_PREVIEW_CAPABILITY as capabilityId } from '@peer-agent/protocol';
import { createDesktopPreviewAdapter, fingerprintPreviewSources, fingerprintPreviewBuild } from './desktop-preview-adapter.mjs';
import { createUiDeliveryAuthority } from './ui-delivery-authority.mjs';
import { createVisualRequestReceiptStore } from './visual-request-receipts.mjs';
import { registerDesktopPreviewObservation } from './desktop-preview-service.mjs';
import { createPermissionGrant, createFailedClientToolResult, nowIso } from './tool-result-factory.mjs';

export function createLocalDesktopPreviewProvider({ workspaceRoot, userDataPath, goalPlanStore, nativeImage, adapter, hostVisualReview } = {}) {
  const previews = adapter ?? createDesktopPreviewAdapter({ workspaceRoot });
  const artifacts = createDesktopPreviewArtifactStore({ userDataPath, workspaceRoot, goalPlanStore });
  const authority = createUiDeliveryAuthority({ userDataPath, goalPlanStore, artifacts, currentIdentity: (conversationId, host) => {
    // 网页要求由浏览器 provider 自己解析身份；这里只答桌面宿主，避免用桌面实例冒充网页。
    if (host === 'web') return null;
    const s = previews.get(conversationId);
    if (!s?.child?.connected) return null;
    return { instanceId: s.instanceId, sourceFingerprint: fingerprintPreviewSources(workspaceRoot), buildFingerprint: fingerprintPreviewBuild(workspaceRoot) };
  } });
  const requestReceipts = createVisualRequestReceiptStore({ userDataPath });
  /** Admission is authority-owned metadata. Byte/ledger verification must never see it,
   * so a derived admission cannot masquerade as a verified candidate. "No claim" is the
   * empty string, the same value the durable record uses. */
  function withoutAdmission(observation) {
    return { ...observation, admittedToRunId: '' };
  }
  function validateVisualSource(visual, source) {
    const plan = goalPlanStore.getPlan(source.planId);
    if (plan?.conversationId !== source.conversationId) throw new Error('preview-source-scope');
    const snapshot = authority.read(plan.planId);
    const observation = snapshot.observations?.find(item => item.artifactRef === visual.artifactRef
      && item.evidenceRef === `tool-result://${source.toolCallId}`);
    const requirement = snapshot.requirements?.[0];
    if (!observation || !requirement || ['instanceId', 'buildFingerprint', 'requirementRevision'].some(
      field => requirement[field] !== observation[field])) throw new Error('preview-source-stale');
    if ((visual.scene ?? 'application') !== (observation.scene ?? 'application')) throw new Error('preview-source-scene');
    return artifacts.read(visual.artifactRef, plan, withoutAdmission(observation));
  }
  function persistPrepareFailure(planId, token, error) {
    const reason = typeof error?.message === 'string' ? error.message : '';
    if (!reason.startsWith('visual-review-')) return;
    try { authority.recordReviewFailure(planId, token, reason); } catch { /* best-effort */ }
  }
  /** Scheduling a host review must never be silent. A missing host, a throwing schedule and a
   * refused schedule all leave the close gate on an empty judgment set unless the authority
   * records why, so every non-benign outcome lands as a diagnosable `visual-review-*` failure.
   * The benign reasons are the two where this exact image already has a review in flight or
   * already admitted: those must leave the gate exactly as it was. */
  const BENIGN_REVIEW_SKIPS = ['preview-review-in-flight', 'preview-review-already-admitted'];
  function scheduleHostReview(plan, observation, context) {
    const refuse = (reason) => {
      try { authority.recordReviewFailure(plan.planId, null, reason); } catch { /* best-effort */ }
      return { scheduled: false, reason };
    };
    if (!hostVisualReview?.schedule) return refuse('visual-review-host-unavailable');
    let receipt;
    try {
      receipt = hostVisualReview.schedule(plan, observation, {
        goalPlanStore, workspacePath: workspaceRoot,
        llmChatService: context.llmChatService, modelProviderId: context.modelProviderId,
        // A host review that fails on its own must land as a diagnosable failure on the
        // captured image. Swallowing it leaves the close gate stuck on an empty judgment set.
        onFailure: (failedPlanId, reason) => {
          try { authority.recordReviewFailure(failedPlanId, null, reason); } catch { /* best-effort */ }
        },
      });
    } catch (error) {
      const message = typeof error?.message === 'string' ? error.message : '';
      return refuse(message.startsWith('visual-review-') ? message : 'visual-review-host-schedule-error');
    }
    if (receipt?.scheduled === true) {
      return { scheduled: true, verifierRunId: receipt.verifierRunId ?? null, reason: null };
    }
    const reason = receipt?.reason ?? 'preview-review-unscheduled';
    if (BENIGN_REVIEW_SKIPS.includes(reason)) return { scheduled: false, reason, benign: true };
    return refuse(`visual-review-not-scheduled:${reason}`);
  }
  function prepareVisualReview(planId, verifierRunId, signal) {
    signal?.throwIfAborted();
    const plan = goalPlanStore.getPlan(planId);
    if (!plan?.conversationId || !verifierRunId) throw new Error('visual-review-plan-missing');
    let token;
    try {
      const review = authority.beginReview(planId, verifierRunId, signal);
      token = review.token;
      const stored = artifacts.read(review.observation.artifactRef, plan, withoutAdmission(review.observation));
      const id = artifactIdFromRef(stored.artifactRef);
      const { bytes } = readPreviewFile(userDataPath, `ui-delivery/artifacts/${id}.png`, 8 * 1024 * 1024);
      if (createHash('sha256').update(bytes).digest('hex') !== stored.artifactHash) throw new Error('visual-review-image-changed');
      const visual = { kind: 'desktop_preview', mediaType: 'image/png', artifactRef: stored.artifactRef, scene: stored.scene ?? 'application',
        dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, width: stored.width, height: stored.height };
      registerDesktopPreviewObservation(visual, stored.toolCallId,
        { planId, conversationId: plan.conversationId, workspaceRoot, goalPlanStore });
      signal?.throwIfAborted();
      return createDesktopVisualReview({ plan, verifierRunId, workspacePath: workspaceRoot, goalPlanStore, visual, signal, reviewToken: token,
        finish: (response, scope) => authority.finishReview(planId, token, response, scope),
        cancel: () => authority.cancelReview(planId, token),
        recordFailure: (reason) => authority.recordReviewFailure(planId, token, reason) });
    } catch (error) {
      persistPrepareFailure(planId, token, error);
      if (token && !(typeof error?.message === 'string' && error.message.startsWith('visual-review-'))) {
        authority.cancelReview(planId, token);
      }
      throw error;
    }
  }
  const busy = new Set();
  async function executeCapability({ call }, context = {}) {
    if (call.capabilityId !== capabilityId) return null;
    const args = call.arguments || {};
    const conversationId = context.toolContext?.conversationId;
    const plan = typeof args.planId === 'string' ? goalPlanStore.getPlan(args.planId) : null;
    const fail = (reason, permissionGrant, status = 'failed') => ({ permissionGrant,
      result: createFailedClientToolResult({ call, reason, locale: context.locale, dataLevel: 'D2_sensitive', status }) });
    if (typeof args.planId !== 'string' || !args.planId) return fail('preview-plan-required');
    if (!conversationId) return fail('preview-conversation-missing');
    if (!plan) return fail('preview-plan-missing');
    if (plan.conversationId !== conversationId) return fail('preview-plan-conversation-mismatch');
    if (!['open', 'observe', 'close'].includes(args.action)
      || Object.keys(args).some(key => !['planId', 'action', 'scene'].includes(key))) return fail('preview-invalid-action');
    if (args.scene !== undefined && (args.action !== 'observe'
      || !['application', 'background-runtime'].includes(args.scene))) return fail('preview-scene-invalid');
    const scene = args.scene ?? 'application';
    const decision = await context.requestPermission?.({ call, toolCallId: call.toolCallId, capabilityId,
      toolName: 'desktop_preview', args: { ...args, workspacePath: workspaceRoot },
      riskLevel: 'L4_privileged', locale: context.locale, dataLevel: 'D2_sensitive',
      reason: 'Build/launch, observe or close a separate Peer preview with empty test data. No current host or daily profile access.' });
    const permissionGrant = createPermissionGrant({ toolCallId: call.toolCallId, granted: decision?.granted === true,
      scope: { capabilityId, conversationId, planId: plan.planId, workspacePath: workspaceRoot, action: args.action,
        ...(args.action === 'observe' ? { scene } : {}) }, duration: decision?.duration });
    if (decision?.granted !== true) return fail('preview-permission-denied', permissionGrant, 'denied');
    if (busy.has(conversationId)) return fail('preview-busy', permissionGrant);
    busy.add(conversationId);
    const startedAt = nowIso();
    try {
      const signal = context.signal;
      signal?.throwIfAborted();
      let output; let artifactRefs = []; let modelContext;
      if (args.action === 'open') {
        const identity = await previews.open(conversationId, signal);
        signal?.throwIfAborted();
        try { authority.requirePreview(plan, identity); } catch (error) { await previews.close(conversationId); throw error; }
        output = { action: 'open', ...identity, judgment: 'missing' };
      } else if (args.action === 'close') {
        // Close waits for an independent passed judgment on the captured image.
        // The live instance may already be gone; that does not by itself block close.
        if (plan) {
          let snapshot;
          try { snapshot = authority.read(plan.planId); }
          catch (error) { return fail(error?.message || 'preview-review-pending', permissionGrant); }
          const first = snapshot.judgments?.[0];
          if (first?.decision === 'failed') {
            output = { action: 'close', reviewFailure: first.reason || 'visual-review-failed', ...await previews.close(conversationId) };
          } else if (snapshot.required === true && first?.decision !== 'passed'
            && !['cancelled', 'paused'].includes(plan.status)
            && plan.runner?.status !== 'paused') {
            return fail('preview-review-pending', permissionGrant);
          }
        }
        if (!output) output = { action: 'close', ...await previews.close(conversationId) };
      } else {
        authority.beginObservation(plan, scene);
        const observation = await previews.observe(conversationId, signal, scene);
        signal?.throwIfAborted();
        if (observation.scene !== scene) throw new Error('preview-scene-mismatch');
        const png = Buffer.from(observation.pngBase64, 'base64');
        const image = nativeImage.createFromBuffer(png);
        const size = image.getSize();
        if (png.length > 8 * 1024 * 1024 || image.isEmpty() || size.width !== observation.width || size.height !== observation.height) throw new Error('preview-invalid-png');
        const stored = artifacts.write({ plan, observation, toolCallId: call.toolCallId, png, ...size });
        const { artifactRef, artifactHash, filePath } = stored;
        authority.recordObservation(plan, stored);
        const hostReview = scheduleHostReview(plan, stored, context);
        artifactRefs = [artifactRef];
        output = { action: 'observe', scene, instanceId: observation.instanceId, buildFingerprint: observation.buildFingerprint,
          artifactRef, artifactHash, filePath, width: size.width, height: size.height, judgment: 'missing', hostReview };
        modelContext = { visualObservations: [{ kind: 'desktop_preview', mediaType: 'image/png', artifactRef, scene,
          dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: size.width, height: size.height }] };
      }
      for (const observation of modelContext?.visualObservations ?? []) registerDesktopPreviewObservation(observation, call.toolCallId,
        { planId: plan.planId, conversationId, workspaceRoot, goalPlanStore });
      return { permissionGrant, result: { toolCallId: call.toolCallId, capabilityId, executorId: 'local-desktop-preview',
        status: 'success', startedAt, completedAt: nowIso(), outputPreview: output,
        evidence: { evidenceId: `evidence_${randomUUID()}`, toolCallId: call.toolCallId, capabilityId,
          summary: `Desktop preview ${args.action}; no product judgment implied.`, artifactRefs,
          userArtifacts: artifactRefs.map(ref => ({ ref, kind: 'image', label: 'Desktop preview.png' })) },
        ...(modelContext ? { modelContext } : {}),
        output: { kind: 'local_capability_result', status: 'completed', output } } };
    } catch (error) {
      if (context.signal?.aborted) await previews.close(conversationId);
      return fail(context.signal?.aborted ? 'preview-aborted' : error.message || 'preview-failed',
        permissionGrant, context.signal?.aborted ? 'cancelled' : 'failed');
    } finally { busy.delete(conversationId); }
  }
  return { providerId: 'local.desktop.preview', capabilityIds: [capabilityId], executeCapability, authority,
    artifacts, requestReceipts, validateVisualSource, prepareVisualReview, hostVisualReview, dispose: previews.closeAll };
}
