import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, renameSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { previewRequirementRevision as revisionOf, readPreviewFile, ensurePreviewDirectory } from './desktop-preview-artifacts.mjs';
import path from 'node:path';
import { consumeVerifiedVisualResponse } from '../provider-transports/visual-request-context.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const JUDGMENT_DECISIONS = new Set(['passed', 'failed', 'unknown']);
function present(filePath) {
  try { lstatSync(filePath); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
/** Local evidence ledger. Observations alone never satisfy evaluation. Only an
 * independent host review can attach an ephemeral judgment using one-use response
 * provenance; disk candidates and model tool arguments cannot restore it.
 */
// currentIdentity(conversationId, host) 由宿主自己提供“当前实例身份”。网页宿主没有实例别名，
// 也允许完全不提供：此时以最新观察的身份为准（第 30 节：复核的是账本截图，不是实例是否还活着）。
export function createUiDeliveryAuthority({ userDataPath, goalPlanStore, currentIdentity = () => null, artifacts }) {
  const reviews = new Map(); // Deliberately ephemeral: restart requires a new review.
  const pending = new Map();
  // In-process revocation (abort/teardown). Not persisted: an abort is a projection
  // withdrawal for this process, while a paused/cancelled plan revokes durably below.
  const revokedPlans = new Set();
  // The reviewed candidate is the latest captured image. Live preview identity is not
  // part of the key: closing the instance after capture must not stale an in-flight review.
  // Admission is derived metadata, so it is excluded: otherwise the identity would flip
  // as soon as a review succeeds and the in-memory handle would be discarded.
  const reviewKey = snapshot => {
    const observation = snapshot.observations.at(-1);
    return JSON.stringify({
      artifactRef: observation?.artifactRef, artifactHash: observation?.artifactHash,
      instanceId: observation?.instanceId, requirementRevision: observation?.requirementRevision,
      buildFingerprint: observation?.buildFingerprint,
    });
  };
  const directory = path.join(userDataPath, 'ui-delivery');
  const fileFor = planId => path.join(directory, `${digest(planId)}.json`);
  const markers = path.join(directory, 'required');
  const markerFor = planId => path.join(markers, digest(planId));
  function load(planId) {
    return JSON.parse(readPreviewFile(userDataPath, `ui-delivery/${digest(planId)}.json`).bytes.toString('utf8'));
  }
  function save(planId, record) {
    reviews.delete(planId);
    pending.delete(planId);
    ensurePreviewDirectory(userDataPath, 'ui-delivery/required');
    // Establish durable fail-closed requirement before writing observations.
    const markerTemporary = `${markerFor(planId)}.${randomUUID()}.tmp`;
    writeFileSync(markerTemporary, 'required', { flag: 'wx', mode: 0o600 });
    renameSync(markerTemporary, markerFor(planId));
    const temporary = `${fileFor(planId)}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, fileFor(planId));
  }
  /** A persisted judgment is trusted only while it is bound to the latest observation
   * and its review Evidence is still indexed by the plan store. A hand-edited or stale
   * record therefore degrades to "needs a new review" instead of granting a pass. */
  function verifiedJudgments(state) {
    const latest = state.observations.at(-1);
    const indexed = new Set(goalPlanStore.listEvidenceIndex().map(record => record.evidenceRef));
    const verified = new Map();
    for (const judgment of state.judgments) {
      if (!latest || judgment?.requirementId !== latest.requirementId
        || judgment.observationRef !== latest.evidenceRef
        || judgment.artifactRef !== latest.artifactRef
        || judgment.artifactHash !== latest.artifactHash
        || !JUDGMENT_DECISIONS.has(judgment.decision)
        || (judgment.decision !== 'failed'
          && (typeof judgment.modelRunId !== 'string' || !judgment.modelRunId))
        || typeof judgment.evidenceRef !== 'string' || !indexed.has(judgment.evidenceRef)) continue;
      verified.set(judgment.artifactRef, judgment);
    }
    return verified;
  }

  function persistJudgment(planId, observation, judgment) {
    const persisted = load(planId);
    const next = {
      ...judgment,
      artifactRef: observation.artifactRef,
      artifactHash: observation.artifactHash,
    };
    persisted.judgments = [
      ...(persisted.judgments ?? []).filter(entry => entry.observationRef !== observation.evidenceRef
        && entry.artifactRef !== observation.artifactRef),
      next,
    ];
    save(planId, persisted);
  }
  function requirePreview(plan, identity, host = 'desktop') {
    if (host !== 'desktop' && host !== 'web') throw new Error('preview-host-invalid');
    const existing = present(fileFor(plan.planId)) ? load(plan.planId) : null;
    const keepHistory = existing
      && existing.planId === plan.planId
      && existing.conversationId === plan.conversationId
      && (existing.host ?? 'desktop') === host
      && Array.isArray(existing.observations)
      && Array.isArray(existing.judgments);
    const identityChanged = keepHistory
      && (existing.sourceFingerprint !== identity.sourceFingerprint
        || existing.buildFingerprint !== identity.buildFingerprint
        || existing.instanceId !== identity.instanceId
        || existing.requirementRevision !== revisionOf(plan));
    save(plan.planId, { planId: plan.planId, conversationId: plan.conversationId, host,
      requirementRevision: revisionOf(plan), sourceFingerprint: identity.sourceFingerprint,
      buildFingerprint: identity.buildFingerprint, instanceId: identity.instanceId,
      ...(keepHistory && existing.scene ? { scene: existing.scene } : {}),
      ...(keepHistory && (existing.capturing || identityChanged) ? { capturing: true } : {}),
      observations: keepHistory ? existing.observations : [],
      judgments: keepHistory ? existing.judgments : [] });
  }
  function beginObservation(plan, scene = 'application') {
    const state = load(plan.planId);
    if (!['application', 'background-runtime'].includes(scene)) throw new Error('preview-scene-invalid');
    if (state.planId !== plan.planId || state.conversationId !== plan.conversationId
      || state.requirementRevision !== revisionOf(plan)) throw new Error('preview-observation-stale');
    if (state.scene === 'background-runtime' && scene !== state.scene) throw new Error('preview-scene-downgrade');
    // Keep prior shots and their judgments. A recapture in flight must not grant the
    // previous pass, so capturing hides the current gate until the new image lands.
    save(plan.planId, { ...state, scene, capturing: true });
  }
  function recordObservation(plan, observation) {
    const state = load(plan.planId);
    if (state.conversationId !== plan.conversationId || state.requirementRevision !== revisionOf(plan)
      || state.instanceId !== observation.instanceId || state.buildFingerprint !== observation.buildFingerprint) throw new Error('preview-observation-stale');
    if ((observation.scene ?? 'application') !== (state.scene ?? 'application')) throw new Error('preview-scene-mismatch');
    const host = state.host ?? 'desktop';
    // A capture from another host must not satisfy this requirement, and the ledger must not
    // be able to mix the two: a desktop shot never stands in for a web artifact (or vice versa).
    if ((observation.host ?? 'desktop') !== host) throw new Error('preview-observation-host-mismatch');
    // Keep prior shots and their judgments. The new image does not inherit a pass:
    // verifiedJudgments only honors a judgment bound to the latest observation.
    state.capturing = false;
    state.observations.push({ ...observation, requirementId: 'ui-artifact', host,
      requirementRevision: state.requirementRevision, admittedToRunId: '' });
    save(plan.planId, state);
  }
  function read(planId, hostPlan) {
    if (!present(markerFor(planId))) {
      if (present(fileFor(planId)) || goalPlanStore.listEvidenceIndex().some(record =>
        record.planId === planId && record.capabilityId === 'local.desktop.preview'
        && record.artifactRefs?.some(ref => ref.startsWith('local-desktop-preview-artifact://')))) {
        throw new Error('preview-requirement-marker-missing');
      }
      return { required: false };
    }
    if (readPreviewFile(userDataPath, `ui-delivery/required/${digest(planId)}`, 16).bytes.toString() !== 'required') {
      throw new Error('preview-requirement-marker-invalid');
    }
    // The store passes its candidate directly: never recurse through getPlan.
    const plan = hostPlan === undefined ? goalPlanStore.getPlan(planId) : hostPlan;
    if (!plan) throw new Error('preview-plan-missing');
    if (plan.planId !== planId) throw new Error('preview-plan-mismatch');
    const state = load(planId);
    if (state.planId !== planId || state.conversationId !== plan.conversationId
      || !Array.isArray(state.observations) || !Array.isArray(state.judgments)) throw new Error('preview-record-invalid');
    // A pause/cancel is an explicit revocation: durable review must not outlive it.
    // An aborted verifier signal counts as cancellation for this process.
    const inMemory = reviews.get(planId);
    const revoked = plan.status === 'paused' || plan.status === 'cancelled'
      || plan.runner?.status === 'paused' || revokedPlans.has(planId)
      || inMemory?.signal?.aborted === true;
    // A persisted judgment is only honored while it is bound to the latest image and
    // its review Evidence is still indexed. Nothing here trusts the model or raw disk.
    const admitted = revoked || state.capturing ? new Map() : verifiedJudgments(state);
    if (state.scene !== undefined && !['application', 'background-runtime'].includes(state.scene)) throw new Error('preview-scene-invalid');
    const latestIndex = state.observations.length - 1;
    for (const [index, observation] of state.observations.entries()) {
      if (observation.requirementId !== 'ui-artifact' || observation.host !== (state.host ?? 'desktop')) {
        throw new Error('preview-observation-mismatch');
      }
      // Historical shots may predate the current instance/build/scene. Only the
      // latest current-identity capture is required to match the ledger identity,
      // and a recapture in flight is not yet that capture.
      if (!state.capturing && index === latestIndex
        && ((observation.scene ?? 'application') !== (state.scene ?? 'application')
          || observation.requirementRevision !== state.requirementRevision
          || observation.sourceFingerprint !== state.sourceFingerprint
          || observation.instanceId !== state.instanceId
          || observation.buildFingerprint !== state.buildFingerprint)) {
        throw new Error('preview-observation-mismatch');
      }
      // 同一套受治理的 UI 产物仓服务两种宿主；read() 会按 ref 前缀与记录声明的宿主
      // 交叉校验，所以桌面产物不可能靠改前缀冒充网页产物（反之亦然）。
      if (!artifacts?.read) throw new Error('preview-artifact-store-missing');
      artifacts.read(observation.artifactRef, plan, observation);
    }
    const current = currentIdentity(state.conversationId, state.host ?? 'desktop');
    const latest = state.observations.at(-1);
    const fresh = current && current.sourceFingerprint === state.sourceFingerprint;
    // A closed preview is not a new requirement. Evaluate the captured image; a live
    // instance that moved still projects as a different identity so the old shot is stale.
    const identity = current
      ? { requirementRevision: revisionOf(plan),
          buildFingerprint: fresh ? current.buildFingerprint : 'unavailable', instanceId: current.instanceId }
      : latest
        ? { requirementRevision: latest.requirementRevision,
            buildFingerprint: latest.buildFingerprint, instanceId: latest.instanceId }
        : { requirementRevision: revisionOf(plan), buildFingerprint: 'unavailable', instanceId: 'closed' };
    const snapshot = { required: true, requirements: [{ id: 'ui-artifact', host: state.host ?? 'desktop', ...identity }],
      observations: state.observations.map(item => ({ ...item,
        admittedToRunId: admitted.get(item.artifactRef)?.modelRunId ?? '' })),
      judgments: [...admitted.values()].map(({ requirementId, observationRef, modelRunId, evidenceRef, decision, reason }) =>
        ({ requirementId, observationRef, modelRunId, evidenceRef, decision, reason })) };
    const review = reviews.get(planId);
    if (review && !review.signal?.aborted && review.key === reviewKey(snapshot)) {
      snapshot.observations = snapshot.observations.map(item => item.artifactRef === review.artifactRef
        ? { ...item, admittedToRunId: review.judgment.modelRunId } : item);
      snapshot.judgments = [{ ...review.judgment }];
    } else reviews.delete(planId);
    return snapshot;
  }
  /** In-process withdrawal of the review projection (abort, teardown, explicit cancel).
   * The durable record is untouched: only a paused/cancelled plan revokes it, because an
   * abort also happens on ordinary run teardown and must not erase a real review. */
  function markRevoked(planId) {
    revokedPlans.add(planId);
    reviews.delete(planId);
  }

  function beginReview(planId, verifierRunId, signal) {
    reviews.delete(planId);
    pending.delete(planId);
    signal?.throwIfAborted();
    const snapshot = read(planId);
    const observation = snapshot.observations?.at(-1);
    if (!observation || load(planId).capturing) throw new Error('visual-review-current-image-missing');
    const plan = goalPlanStore.getPlan(planId);
    const current = currentIdentity(plan?.conversationId, snapshot.requirements?.[0]?.host ?? 'desktop');
    // A closed preview still reviews the captured image. A live instance that moved
    // (replaced id or source) is a true identity mismatch and must not review the old shot.
    if (current && (current.instanceId !== observation.instanceId
      || current.sourceFingerprint !== observation.sourceFingerprint)) {
      throw new Error('visual-review-current-image-missing');
    }
    const token = Object.freeze({});
    pending.set(planId, { token, key: reviewKey(snapshot), verifierRunId, signal });
    // An abort/cancel withdraws the review projection for this process.
    if (signal?.aborted) markRevoked(planId);
    else signal?.addEventListener('abort', () => markRevoked(planId), { once: true });
    return { token, observation };
  }
  function finishReview(planId, token, response, scope) {
    const request = pending.get(planId);
    if (!request || request.token !== token) throw new Error('visual-review-handle-stale');
    pending.delete(planId);
    request.signal?.throwIfAborted();
    const plan = goalPlanStore.getPlan(planId);
    if (scope.goalPlanStore !== goalPlanStore || scope.conversationId !== plan?.conversationId
      || scope.streamId !== request.verifierRunId) throw new Error('visual-review-response-scope');
    const snapshot = read(planId);
    if (request.key !== reviewKey(snapshot)) throw new Error('visual-review-current-image-changed');
    const proof = consumeVerifiedVisualResponse(response, { ...scope, reviewToken: token });
    const observation = snapshot.observations.at(-1);
    if (proof.candidate?.status !== 'validated-candidate' || proof.observations.length !== 1
      || proof.observations[0].artifactRef !== observation.artifactRef
      || proof.observations[0].artifactHash !== observation.artifactHash) throw new Error('visual-review-report-invalid');
    const report = JSON.parse(proof.text);
    const assessment = report.assessments[0];
    const evidenceRef = `visual-review://${proof.requestId}`;
    goalPlanStore.recordEvidenceRefs({ evidenceRef, planId, conversationId: scope.conversationId,
      artifactRefs: [observation.artifactRef], streamId: request.verifierRunId });
    const judgment = {
      requirementId: observation.requirementId, observationRef: observation.evidenceRef,
      modelRunId: proof.modelRunId, evidenceRef,
      decision: assessment.verdict === 'inconclusive' ? 'unknown' : assessment.verdict,
    };
    reviews.set(planId, { key: request.key, signal: request.signal, artifactRef: observation.artifactRef, judgment });
    revokedPlans.delete(planId);
    // A host review is durable: persist the minted judgment next to the image it judged,
    // so a restart re-reads a pass that is still backed by indexed review Evidence
    // instead of silently degrading to judgment-missing. The admission itself stays
    // derived (never stored) and is re-derived from a verified judgment on every read.
    persistJudgment(planId, observation, judgment);
    return { passed: assessment.verdict === 'passed', verdict: assessment.verdict,
      scene: observation.scene ?? 'application', artifactRef: observation.artifactRef,
      evidenceRefs: [observation.evidenceRef, evidenceRef],
      findings: assessment.findings, repairSuggestions: assessment.repairSuggestions,
      summary: assessment.findings.join('\n'), recommendedNextAction: assessment.verdict === 'passed' ? 'complete' : 'repair' };
  }
  /** Persist a deterministic review failure (e.g. non-vision provider, missing wire) as a
   * 'failed' judgment so the close gate can release with a diagnosable reason instead of
   * silently blocking on an always-empty judgment set. A cancelled verifier is not a failure. */
  function recordReviewFailure(planId, token, reason) {
    const request = pending.get(planId);
    if (token != null && (!request || request.token !== token)) return;
    if (request) pending.delete(planId);
    if (request?.signal?.aborted) {
      markRevoked(planId);
      return;
    }
    // 失败判定绝不能依赖「准入级」校验：read() 会拿证据索引复核产物字节，而索引是工具结果
    // 返回之后才写的。复核恰好在 observe 调用内部调度，正处在这个窗口里；若这里沿用 read()，
    // 失败就会在每层 catch{} 里被吞掉——正是本路径要消灭的静默。负面判定只需要一条观察记录。
    const persisted = load(planId);
    const observation = persisted.observations?.at(-1);
    if (!observation) {
      markRevoked(planId);
      return;
    }
    const plan = goalPlanStore.getPlan(planId);
    const evidenceRef = `visual-review-failure://${randomUUID()}`;
    goalPlanStore.recordEvidenceRefs({
      evidenceRef, planId, conversationId: plan?.conversationId ?? planId,
      artifactRefs: [observation.artifactRef],
    });
    const judgment = {
      requirementId: observation.requirementId,
      observationRef: observation.evidenceRef,
      modelRunId: null,
      evidenceRef,
      decision: 'failed',
      reason,
    };
    reviews.set(planId, {
      key: request?.key ?? reviewKey(persisted), signal: request?.signal, artifactRef: observation.artifactRef, judgment,
    });
    revokedPlans.delete(planId);
    persistJudgment(planId, observation, judgment);
  }
  function cancelReview(planId, token) {
    if (pending.get(planId)?.token !== token) return;
    pending.delete(planId);
    markRevoked(planId);
  }
  /** 网页没有关闭义务，改用失效规则：受治理截图之后若同一计划再发生改动页面的浏览器
   * 动作，该截图立即不再构成证据（观察与判定一并清空）。这样「先截图、再改页面、再宣称
   * 完成」不成立。只作用于同一会话内的网页宿主要求，不触碰桌面链。 */
  function invalidateWebRequirements(conversationId, reason) {
    const invalidated = [];
    if (!conversationId) return { invalidated };
    let names = [];
    try { names = readdirSync(directory); } catch { return { invalidated }; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let state;
      try { state = JSON.parse(readFileSync(path.join(directory, name), 'utf8')); } catch { continue; }
      if ((state?.host ?? 'desktop') !== 'web' || state.conversationId !== conversationId || !state.planId) continue;
      markRevoked(state.planId);
      save(state.planId, { ...state, observations: [], judgments: [],
        invalidatedReason: reason ?? 'web-page-changed', invalidatedAt: new Date().toISOString() });
      invalidated.push(state.planId);
    }
    return { invalidated };
  }
  return { read, requirePreview, beginObservation, recordObservation, beginReview, finishReview, recordReviewFailure, cancelReview, invalidateWebRequirements };
}
