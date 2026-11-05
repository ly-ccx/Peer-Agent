import { randomUUID, createHash } from 'node:crypto';
import { INTERACTIVE_PUBLISH_CAPABILITY as PUBLISH, INTERACTIVE_INSPECT_CAPABILITY as INSPECT, normalizeInteractiveUserArtifact,
  normalizeInteractiveOwner, normalizeInteractiveReference, normalizeInteractiveReviewBinding, normalizeInteractiveInspectionReceipt,
  interactiveInspectionEvidenceRef, isInteractiveInspectionEvidenceRef, parseInteractiveArtifactRef, isInteractiveFeedbackAttachment } from '@peer-agent/protocol';
import { validateState } from '@peer-agent/interactive-content/state';
import { executionIdentity, sameExecution } from '../project-agent/session-control-kernel.mjs';
import { sessionExecutionCurrent } from '../project-agent/execution-ownership.mjs';
import { encode, jsonDigest, problem } from './storage.mjs';

const same = (a, b) => encode(a) === encode(b);
const hash = value => createHash('sha256').update(encode(value)).digest('hex');
function taskRefs(plan) {
  const refs = new Set((plan?.criterionResults ?? []).map(row => row.evidenceRef).filter(Boolean));
  const visit = tasks => { for (const task of tasks ?? []) { for (const ref of task.evidenceRefs ?? []) refs.add(ref); visit(task.subtasks); } };
  visit(plan?.tasks); return [...refs];
}
const hasFeedback = message => message.role === 'user' && (message.resourceFeedback?.some?.(row => row?.resource?.kind === 'interactive')
  || message.attachments?.some?.(isInteractiveFeedbackAttachment));
export function interactiveVerificationRequired(plan, messages = []) {
  return plan?.delegationOrigin?.capabilityAdmission?.required?.some(id => [PUBLISH, INSPECT].includes(id))
    || plan?.successCriteria?.some(row => row.requiredCapabilities?.some(id => [PUBLISH, INSPECT].includes(id)))
    || taskRefs(plan).some(ref => !!parseInteractiveArtifactRef(ref) || isInteractiveInspectionEvidenceRef(ref)) || messages.some(hasFeedback);
}
/** Keep the lifetime fence around the whole verifier, including preparation failures and cancellation. */
export async function withInteractiveVerification({ service, plan, messages, verifierRunId, readSourceRevision }, run) {
  if (!service && interactiveVerificationRequired(plan, messages)) throw problem('interactive_verification_unavailable');
  const review = service?.prepare({ plan, verifierRunId, readSourceRevision });
  try { return await run(review); } finally { review?.close(); }
}
function fullRange(receipts, predicate) {
  const rows = receipts.filter(predicate).filter(row => row.range && !row.computationTruncated);
  if (!rows.length) return false;
  const total = rows[0].range.total;
  if (rows.some(row => row.range.total !== total)) return false;
  let end = 0;
  for (const row of rows.sort((a, b) => a.range.offset - b.range.offset)) {
    if (row.range.offset > end) return false;
    end = Math.max(end, row.range.offset + row.range.returned);
  }
  return end === total;
}

/** Host-owned target admission and factual coverage, never a semantic verdict or an execution port. */
export function createInteractiveVerification({ resultStore, feedback, goalPlanStore, conversationStore,
  getBotConversationId, holdsLease, enabled }) {
  const active = new Map(), retentionOwners = new Set();
  let disposed = false;
  const currentOwner = owner => !disposed && enabled?.(owner.workspaceId) === true && holdsLease?.(owner.workspaceId) === true
    && getBotConversationId?.(owner.workspaceId) === owner.conversationId;
  const messagesFor = plan => conversationStore?.getPersistedConversationHistory?.(plan.conversationId)?.messages ?? [];
  const recordsFor = refs => goalPlanStore.findEvidenceIndexRecords(refs);
  function targetsFor(plan) {
    const origin = plan?.delegationOrigin, owner = { workspaceId: origin?.workspaceId, conversationId: origin?.parentConversationId };
    const messages = messagesFor(plan), required = interactiveVerificationRequired(plan, messages);
    // Task tool aliases are resolved against this plan's real publication call,
    // not a globally colliding tool-result:// ID or an assistant URI.
    const ownOperations = taskRefs(plan).flatMap(ref => {
      if (typeof ref !== 'string' || !ref.startsWith('tool-result://') || !origin) return [];
      const call = { owner, conversationId: plan.conversationId, toolCallId: ref.slice(14) };
      try { const receipt = resultStore.getOperation(call); return receipt?.publicationStatus === 'published' ? [receipt] : []; }
      catch { return []; }
    });
    if (!required && !ownOperations.length) return { targets: [], digest: null, owner };
    if (!origin || !currentOwner(owner)) throw problem('interactive_verification_unavailable');
    const selected = messages.filter(hasFeedback).flatMap(message => feedback.restore(message, owner.workspaceId))
      .filter(row => row.resource.kind === 'interactive');
    if (selected.some(row => !same(row.recipient, owner))) throw problem('interactive_scope_denied');
    const versions = new Map(), targets = new Map(), selectedRefs = new Set(selected.map(row => encode(row.resource.reference)));
    function admit(raw) {
      const reference = normalizeInteractiveReference(raw);
      if (!reference || !same(reference.owner, owner)) throw problem('interactive_verification_target_invalid');
      const key = encode(reference);
      if (versions.has(key)) return versions.get(key);
      if (versions.size >= 16) throw problem('interactive_verification_target_limit');
      const fixed = resultStore.getVersion(reference), sourcePlan = goalPlanStore.getPlan(fixed.source.planId), sourceOrigin = sourcePlan?.delegationOrigin;
      if (!sourceOrigin || sourceOrigin.workspaceId !== owner.workspaceId || sourceOrigin.parentConversationId !== owner.conversationId
        || sourcePlan.conversationId !== fixed.source.conversationId || sourceOrigin.sessionId !== fixed.source.sessionId
        || fixed.source.planId !== plan.planId && !selectedRefs.has(key)) throw problem('interactive_verification_target_denied');
      const record = recordsFor([fixed.evidenceRef]).find(row => row.evidenceRef === fixed.evidenceRef);
      const artifact = record?.userArtifacts?.map(normalizeInteractiveUserArtifact).find(item => item?.ref === fixed.artifactRef);
      if (!record || !artifact || !same(artifact.reference, reference) || artifact.specHash !== fixed.content.specHash
        || record.planId !== fixed.source.planId || record.conversationId !== fixed.source.conversationId || record.toolCallId !== fixed.source.toolCallId
        || record.capabilityId !== PUBLISH || record.toolName !== 'publish_interactive_result' || record.evidenceRef !== fixed.artifactRef
        || record.createdAt !== fixed.createdAt) throw problem('interactive_verification_publication_unavailable');
      versions.set(key, fixed);
      targets.set(`${key}:initial`, { reference, specHash: fixed.content.specHash, publicationEvidenceRef: fixed.evidenceRef,
        bindings: Object.keys(fixed.content.bindings).sort(), state: { kind: 'initial', stateDigest: jsonDigest(fixed.content.initialValues) } });
      return fixed;
    }
    for (const receipt of ownOperations) admit(receipt.reference);
    for (const ref of taskRefs(plan)) { const reference = parseInteractiveArtifactRef(ref); if (reference) admit(reference); }
    for (const row of selected) {
      const fixed = admit(row.resource.reference), frozen = row.version;
      if (frozen.kind !== 'interactive' || frozen.specHash !== fixed.content.specHash) throw problem('interactive_verification_target_invalid');
      try { validateState(frozen.values, fixed.content.stateSchema); } catch { throw problem('followup_state_incomplete'); }
      if (targets.size >= 32) throw problem('interactive_verification_target_limit');
      targets.set(`${encode(fixed.reference)}:${row.id}`, { reference: fixed.reference, specHash: fixed.content.specHash, publicationEvidenceRef: fixed.evidenceRef,
        bindings: Object.keys(fixed.content.bindings).sort(), state: { kind: 'frozen-followup', followupId: row.id,
          stateRevision: frozen.stateRevision, stateDigest: frozen.stateDigest, selectionDigest: frozen.selectionDigest } });
    }
    if (!targets.size) throw problem('interactive_verification_target_missing');
    const list = [...targets.values()].sort((a, b) => encode(a).localeCompare(encode(b)));
    return { owner, targets: list, digest: jsonDigest(list) };
  }
  function prepare({ plan, verifierRunId, readSourceRevision }) {
    const admitted = targetsFor(plan);
    if (!admitted.targets.length) return null;
    if (retentionOwners.has(encode(admitted.owner))) throw problem('interactive_retention_busy');
    if (active.size >= 32) throw problem('interactive_verification_limit');
    const expected = executionIdentity(plan), token = randomUUID();
    const revisionFor = current => hash([readSourceRevision(current), targetsFor(current).digest]);
    const sourceRevision = revisionFor(plan), review = { verifierRunId, sourceRevision, targetsDigest: admitted.digest };
    const record = { owner: admitted.owner, conversationId: plan.conversationId, expected, targets: admitted.targets, review };
    function assertCurrent() {
      const current = goalPlanStore.getPlan(plan.planId);
      if (disposed || active.get(token) !== record || !current || !sessionExecutionCurrent(current) || !sameExecution(executionIdentity(current), expected)
        || !same(current.delegationOrigin?.parentConversationId, admitted.owner.conversationId)
        || revisionFor(current) !== sourceRevision) throw problem('interactive_verification_stale');
      return true;
    }
    record.assertCurrent = assertCurrent;
    if (!currentOwner(admitted.owner) || retentionOwners.has(encode(admitted.owner))) throw problem('interactive_verification_stale');
    active.set(token, record);
    return { binding: { token }, sourceRevision, readSourceRevision: revisionFor,
      facts: { targetsDigest: admitted.digest, targets: structuredClone(admitted.targets) },
      validateReport(report, allowed) {
        assertCurrent();
        if (report.passed !== true) return report;
        const refs = (report.evidenceRefs ?? []).filter(ref => allowed.has(ref) && isInteractiveInspectionEvidenceRef(ref));
        const receipts = recordsFor(refs).flatMap(row => {
          const receipt = normalizeInteractiveInspectionReceipt(row.interactiveInspection);
          return receipt && row.evidenceRef === interactiveInspectionEvidenceRef(receipt.evidenceId) && row.capabilityId === INSPECT
            && row.toolName === 'inspect_interactive_result' && row.planId === plan.planId && row.conversationId === plan.conversationId
            && sameExecution(receipt.execution, expected) && receipt.conversationId === plan.conversationId
            && receipt.review.sourceRevision === sourceRevision && receipt.review.targetsDigest === admitted.digest ? [receipt] : [];
        });
        const missing = [];
        for (const target of admitted.targets) {
          const sameTarget = receipt => receipt.specHash === target.specHash && same(receipt.request.target.reference, target.reference);
          if (!fullRange(receipts, row => sameTarget(row) && row.request.view === 'program')) missing.push('program');
          for (const bindingId of target.bindings) if (!fullRange(receipts, row => sameTarget(row) && row.request.view === 'data'
            && row.request.bindingId === bindingId && row.request.selector === undefined)) missing.push(`binding:${bindingId}`);
          if (!fullRange(receipts, row => sameTarget(row) && row.request.view === 'evaluate' && same(row.stateSource, target.state))) missing.push('evaluation');
        }
        assertCurrent();
        return missing.length ? { ...report, passed: false, summary: 'Interactive result inspection coverage is incomplete.',
          missingEvidence: [...(report.missingEvidence ?? []), { reason: `interactive_verification_evidence_missing: ${[...new Set(missing)].join(', ')}`, evidenceRefs: [] }],
          recommendedNextAction: 'retry_verification' } : report;
      },
      close() { if (active.get(token) === record) active.delete(token); },
    };
  }
  function resolve(profile) {
    const binding = normalizeInteractiveReviewBinding(profile?.interactiveReview), record = binding && active.get(binding.token);
    if (!record || profile.role !== 'work_session' || !['verifier', 'visual_verifier'].includes(profile.agentKind)
      || profile.workspaceId !== record.owner.workspaceId || profile.planId !== record.expected.planId || profile.sessionId !== record.expected.sessionId
      || !sameExecution(profile.executionIdentity, record.expected)) throw problem('interactive_verification_binding_required');
    record.assertCurrent();
    return { owner: record.owner, conversationId: record.conversationId, review: record.review, assertCurrent: record.assertCurrent,
      admitResult: ref => record.targets.some(target => same(target.reference, ref)),
      admitFollowup: id => record.targets.some(target => target.state.kind === 'frozen-followup' && target.state.followupId === id) };
  }
  // Shared by the leased host's review and maintenance paths. Durable task roots are separate.
  function acquireRetentionVerification(rawOwner) {
    const owner = normalizeInteractiveOwner(rawOwner);
    if (!owner || !currentOwner(owner)) throw problem('interactive_retention_unavailable');
    const key = encode(owner);
    if (retentionOwners.has(key)) throw problem('interactive_retention_busy');
    retentionOwners.add(key);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      retentionOwners.delete(key);
    };
    try {
      const snapshot = () => [...active].filter(([, record]) => same(record.owner, owner));
      const initial = snapshot();
      const references = new Map(), followupIds = new Set();
      for (const [, record] of initial) {
        // Retain the fixed target until its actual lifecycle ends, even if its turn has become stale.
        for (const target of record.targets) {
          references.set(encode(target.reference), target.reference);
          if (target.state.kind === 'frozen-followup') followupIds.add(target.state.followupId);
        }
      }
      const assertCurrent = () => {
        if (released || !currentOwner(owner)) return false;
        const fresh = snapshot();
        return fresh.length === initial.length && fresh.every(([token, record], index) =>
          initial[index][0] === token && initial[index][1] === record);
      };
      return { revision: jsonDigest(initial.map(([token, record]) => [token, record.review])), references: structuredClone([...references.values()]),
        followupIds: [...followupIds].sort(), assertCurrent, release };
    } catch (error) { release(); throw error; }
  }
  return { prepare, resolve, acquireRetentionVerification, dispose() { disposed = true; active.clear(); } };
}
