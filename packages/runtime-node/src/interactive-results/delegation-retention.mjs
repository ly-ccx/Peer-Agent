import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { INTERACTIVE_INSPECT_CAPABILITY, INTERACTIVE_INSPECT_TOOL, interactiveInspectionEvidenceRef, interactiveToken, isInteractiveInspectionEvidenceRef,
  normalizeInteractiveInspectionReceipt, normalizeInteractiveOwner, parseInteractiveArtifactRef } from '@peer-agent/protocol';
import { encode, jsonDigest, problem } from './storage.mjs';

const same = (a, b) => encode(a) === encode(b);
const MAX_PLANS = 2048, MAX_BYTES = 32 * 1024 * 1024, MAX_REFS = 16_384;

function fileRevision(file, missingAllowed = false) {
  try {
    const stat = lstatSync(file, { bigint: true });
    if (!stat.isFile()) throw problem('interactive_delegation_corrupt');
    return { size: Number(stat.size), version: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') };
  } catch (error) {
    if (error.code === 'ENOENT' && missingAllowed) return null;
    throw error;
  }
}

function evidenceRefs(plan) {
  const refs = new Set();
  const add = value => {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some(ref => typeof ref !== 'string')) throw problem('interactive_delegation_corrupt');
    for (const ref of value) {
      refs.add(ref);
      if (refs.size > MAX_REFS) throw problem('interactive_delegation_limit');
    }
  };
  add(plan.evidenceRefs);
  if (plan.criterionResults !== undefined) {
    if (!Array.isArray(plan.criterionResults)) throw problem('interactive_delegation_corrupt');
    add(plan.criterionResults.flatMap(row => row?.evidenceRef === undefined ? [] : [row.evidenceRef]));
  }
  const visit = tasks => {
    if (tasks === undefined) return;
    if (!Array.isArray(tasks)) throw problem('interactive_delegation_corrupt');
    for (const task of tasks) {
      if (!task || typeof task !== 'object' || Array.isArray(task)) throw problem('interactive_delegation_corrupt');
      add(task.evidenceRefs); visit(task.subtasks);
    }
  };
  visit(plan.tasks);
  add(plan.runner?.verificationContinuation?.evidenceRefs);
  return refs;
}

function historicallySettled(plan) {
  const continuation = plan.runner?.verificationContinuation;
  return plan.status === 'completed' && Number.isFinite(Date.parse(plan.resultAcceptance?.acceptedAt))
    && !plan.runner?.interruption && (!plan.runner?.status || ['idle', 'completed'].includes(plan.runner.status))
    && (!continuation || continuation.phase === 'completed')
    && (plan.deliveryHandoff?.status === 'delivered' || !plan.targetWorkspacePath && !plan.deliveryHandoff);
}

/** Reads durable plan facts under the active host lease and a held canonical message guard. */
export function createDelegationRetention({ goalPlanStore, resultStore, stateStore, assertOwner }) {
  return function acquireDelegationRoots(rawOwner, messages) {
    const owner = normalizeInteractiveOwner(rawOwner);
    const current = () => assertOwner(owner) === true && messages.assertCurrent() === true;
    if (!owner || !messages?.conversationIds?.includes(owner.conversationId) || !messages.delegatedSessions
      || typeof goalPlanStore?.getStoreDir !== 'function' || !current())
      throw problem('interactive_retention_unavailable');
    const dir = goalPlanStore.getStoreDir(), evidenceFile = path.join(dir, 'evidence-index.jsonl');
    const list = () => {
      const names = readdirSync(dir).filter(name => name.endsWith('.json')).sort();
      if (names.length > MAX_PLANS) throw problem('interactive_delegation_limit');
      return names;
    };
    const names = list(), versions = new Map(), evidence = fileRevision(evidenceFile, true);
    const conversations = new Set(messages.conversationIds), references = new Map(), followupIds = new Set(), sessions = new Set();
    const pin = reference => {
      if (!same(reference.owner, owner)) throw problem('interactive_delegation_corrupt');
      const key = encode(reference);
      if (!references.has(key)) {
        resultStore.getVersionMetadata(reference);
        references.set(key, reference);
        if (references.size > MAX_REFS) throw problem('interactive_delegation_limit');
      }
    };
    let bytes = 0, refCount = 0, unsettledPlans = 0;
    for (const name of names) {
      const file = path.join(dir, name), fact = fileRevision(file);
      bytes += fact.size;
      if (bytes > MAX_BYTES) throw problem('interactive_delegation_limit');
      versions.set(name, fact.version);
      const plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)));
      if (!interactiveToken(plan?.planId) || name !== plan.planId + '.json') throw problem('interactive_delegation_corrupt');
      const origin = plan.delegationOrigin;
      if (!origin || origin.workspaceId !== owner.workspaceId && !conversations.has(plan.conversationId)) continue;
      if (origin.parentConversationId !== owner.conversationId && !conversations.has(plan.conversationId)) {
        if (interactiveToken(origin.parentConversationId)) continue;
        throw problem('interactive_delegation_corrupt');
      }
      if (origin.workspaceId !== owner.workspaceId || origin.parentConversationId !== owner.conversationId
        || !interactiveToken(origin.sessionId) || sessions.has(origin.sessionId) || !conversations.has(plan.conversationId)
        || messages.delegatedSessions.get(plan.conversationId) !== origin.sessionId) throw problem('interactive_delegation_corrupt');
      sessions.add(origin.sessionId);
      if (historicallySettled(plan)) continue;
      unsettledPlans++;
      const refs = evidenceRefs(plan);
      refCount += refs.size;
      if (refCount > MAX_REFS) throw problem('interactive_delegation_limit');
      for (const ref of refs) {
        if (ref.startsWith('interactive-result://')) {
          const fixed = parseInteractiveArtifactRef(ref);
          if (!fixed) throw problem('interactive_delegation_corrupt');
          pin(fixed);
        } else if (ref.startsWith('tool-result://')) {
          const toolCallId = ref.slice(14);
          if (!interactiveToken(toolCallId)) continue;
          const call = { owner, conversationId: plan.conversationId, toolCallId };
          const operation = resultStore.getOperation(call);
          if (operation) {
            if (!same(operation.callRef, call)) throw problem('interactive_delegation_corrupt');
            pin(operation.reference);
          }
        } else if (ref.startsWith('interactive-inspection://')) {
          if (!isInteractiveInspectionEvidenceRef(ref)) throw problem('interactive_delegation_corrupt');
          const [record] = goalPlanStore.findEvidenceIndexRecords([ref]);
          const receipt = normalizeInteractiveInspectionReceipt(record?.interactiveInspection);
          if (!receipt || interactiveInspectionEvidenceRef(receipt.evidenceId) !== ref || record.evidenceRef !== ref
            || record.planId !== plan.planId || record.conversationId !== plan.conversationId || record.capabilityId !== INTERACTIVE_INSPECT_CAPABILITY
            || record.toolName !== INTERACTIVE_INSPECT_TOOL || record.toolCallId !== receipt.toolCallId || receipt.execution.planId !== plan.planId
            || receipt.execution.sessionId !== origin.sessionId || receipt.conversationId !== plan.conversationId || !same(receipt.owner, owner))
            throw problem('interactive_delegation_corrupt');
          pin(receipt.request.target.reference);
          if (receipt.stateSource?.kind === 'frozen-followup') {
            const frozen = stateStore.readFollowup(owner, receipt.stateSource.followupId);
            if (!same(frozen.result, receipt.request.target.reference) || frozen.selectionDigest !== receipt.stateSource.selectionDigest
              || frozen.stateRevision !== receipt.stateSource.stateRevision || frozen.stateDigest !== receipt.stateSource.stateDigest)
              throw problem('interactive_delegation_corrupt');
            followupIds.add(frozen.followupId);
          }
        }
      }
    }
    const assertCurrent = () => {
      try {
        return current() && same(names, list()) && fileRevision(evidenceFile, true)?.version === evidence?.version
          && [...versions].every(([name, version]) => fileRevision(path.join(dir, name)).version === version);
      } catch { return false; }
    };
    if (!assertCurrent()) throw problem('interactive_retention_stale');
    return { revision: jsonDigest([messages.revision, [...versions], evidence?.version ?? null]), references: [...references.values()],
      followupIds: [...followupIds].sort(), unsettledPlans, assertCurrent };
  };
}
