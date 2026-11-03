import { randomUUID } from 'node:crypto';
import { createEvidenceBundle } from '@peer-agent/runtime-core';
import { INTERACTIVE_INSPECT_CAPABILITY as INSPECT, INTERACTIVE_PUBLISH_CAPABILITY as PUBLISH,
  interactiveToken, normalizeInteractiveDraft, normalizeInteractiveInspect, normalizeInteractiveOwner } from '@peer-agent/protocol';
import { createFailedClientToolResult, createPermissionGrant } from '../tool-result-factory.mjs';
import { selectInteractiveData } from './material-source.mjs';
import { runInteractiveValidation } from './validation.mjs';
import { encode, jsonDigest, problem } from './storage.mjs';

const same = (a, b) => encode(a) === encode(b);
const fail = (code, status = 'failed') => { throw Object.assign(problem(code), { status }); };
const page = (text, request) => {
  const offset = request.offset ?? 0, limit = request.limit ?? 4000;
  if (offset > text.length) fail('interactive_range_exceeded');
  return { text: text.slice(offset, offset + limit), offset, limit, total: text.length, truncated: offset + limit < text.length,
    ...(offset + limit < text.length ? { nextOffset: offset + limit } : {}) };
};

/** Governed execution. Authority, permission and canonical index ports come only from the host. */
export function createInteractiveResultProvider({ store, stateStore, materialSource, resolveAuthority, index,
  validate = runInteractiveValidation, now = () => new Date().toISOString() }) {
  function reconcile(rawCall) {
    const saved = store.getOperation(rawCall);
    if (!saved) fail('publication_unknown');
    if (saved.unchanged || saved.publicationStatus === 'published') return saved;
    if (saved.publicationStatus !== 'index_pending') fail('publication_unknown');
    if (!index?.recordEvidenceRefs || !index?.findEvidenceIndexRecords) fail('publication_index_pending');
    if (index.assertInteractiveEvidenceCompatible?.() !== true) fail('interactive_evidence_incompatible');
    const entry = saved.indexEntry;
    index.recordEvidenceRefs({ ...entry, evidenceRefs: [entry.evidenceRef] }, { durable: true });
    const actual = index.findEvidenceIndexRecords([entry.evidenceRef])[0];
    return store.markIndexed(saved.callRef, actual);
  }
  function recoverOwner(owner, assertOwner) {
    if (!normalizeInteractiveOwner(owner) || typeof assertOwner !== 'function' || assertOwner(owner) !== true) fail('interactive_scope_denied', 'denied');
    return store.listPending(owner).map(receipt => {
      try { return reconcile(receipt.callRef); }
      catch (error) { return { callRef: receipt.callRef, publicationStatus: 'index_pending', code: error.code ?? 'publication_index_pending' }; }
    });
  }
  return { providerId: 'interactive-result-provider', capabilityIds: [PUBLISH, INSPECT], recoverOwner,
    async executeCapability({ call }, { locale = 'zh-CN', toolContext = {}, signal, requestPermission } = {}) {
      if (![PUBLISH, INSPECT].includes(call.capabilityId)) return null;
      let grant = createPermissionGrant({ toolCallId: call.toolCallId, granted: false, scope: call.capabilityId });
      let authority, callRef, dataLevel = 'D2_sensitive';
      const validations = [];
      const guard = () => {
        if (signal?.aborted) fail('interactive_cancelled', 'cancelled');
        const denial = toolContext.checkAccessPolicy?.();
        if (denial || !authority || authority.assertCurrent?.() !== true || validations.some(check => check() !== true)) fail(denial || 'interactive_execution_stale', 'denied');
        return true;
      };
      function result(output, { evidenceId = randomUUID(), artifacts = [], summary = output.kind, status = 'success' } = {}) {
        return { call, grant, result: { toolCallId: call.toolCallId, status, outputPreview: output, completedAt: now(),
          evidence: { ...createEvidenceBundle({ evidenceId, toolCallId: call.toolCallId, locale, dataLevel,
            returnedToCloud: true, summary, artifactRefs: artifacts.map(item => item.ref), metadata: { capabilityId: call.capabilityId,
              ...(output.reference ? { reference: output.reference } : {}), ...(output.stateSource ? { stateSource: output.stateSource } : {}) } }),
            ...(artifacts.length ? { userArtifacts: artifacts } : {}) } } };
      }
      function published(receipt) {
        const content = store.getVersion(receipt.reference);
        dataLevel = content.dataLevel;
        return result({ kind: 'interactive_publication', publicationStatus: 'published', reference: receipt.reference, callRef: receipt.callRef,
          artifactRef: content.artifactRef, title: content.content.title, textFallback: content.content.textFallback,
          ...(receipt.unchanged ? { unchanged: true } : {}) }, { evidenceId: receipt.evidenceId,
          artifacts: receipt.unchanged ? [] : receipt.indexEntry.userArtifacts,
          summary: `Interactive result ${receipt.unchanged ? 'unchanged' : 'published'}: ${content.content.title}; fixed ${receipt.reference.contentVersion}` });
      }
      try {
        if (typeof resolveAuthority !== 'function') fail('interactive_authority_unavailable', 'denied');
        authority = await resolveAuthority({ call, toolContext });
        if (!authority || !normalizeInteractiveOwner(authority.owner) || !authority.capabilityIds?.includes(call.capabilityId)) fail('capability_not_projected', 'denied');
        if (!['D0_public', 'D1_internal', 'D2_sensitive', 'D3_private', 'D4_regulated'].includes(authority.dataLevel)) fail('material_classification_unavailable');
        dataLevel = authority.dataLevel; guard();
        if (call.capabilityId === PUBLISH) {
          if (authority.role !== 'session_worker' || !authority.source || authority.source.toolCallId !== call.toolCallId) fail('interactive_role_denied', 'denied');
          const draft = normalizeInteractiveDraft(call.arguments);
          if (!draft) fail('interactive_draft_invalid');
          callRef = { owner: authority.owner, conversationId: authority.source.conversationId, toolCallId: call.toolCallId };
          const prior = store.getOperation(callRef);
          if (prior) {
            if (prior.argsDigest !== jsonDigest(draft)) fail('publication_parameter_conflict');
            // Reading/reconciling an already committed call never reuses its stored grant or executes it again.
            grant = createPermissionGrant({ toolCallId: call.toolCallId, granted: true, scope: { capabilityId: PUBLISH, operation: 'receipt-read', callRef } });
            return published(reconcile(callRef));
          }
          if (draft.publication.kind === 'revise' && (!same(draft.publication.base.owner, authority.owner)
            || await authority.admitResult?.(draft.publication.base) !== true)) fail('interactive_scope_denied', 'denied');
          guard();
          if (typeof requestPermission !== 'function') fail('interactive_permission_required', 'denied');
          const scope = { kind: 'interactive-result', capabilityId: PUBLISH, owner: authority.owner, source: authority.source, parameterDigest: jsonDigest(draft) };
          const approval = await requestPermission({ capabilityId: PUBLISH, tool: 'publish_interactive_result', toolName: 'publish_interactive_result',
            args: { publication: draft.publication, title: draft.title, parameterDigest: jsonDigest(draft) },
            scope,
            confirmation: { kind: 'capability-approval', approvalKind: 'interactive-result', reason: 'Publish an internal result of this admitted work.' },
            riskLevel: 'L2_local_write', dataLevel });
          if (!approval?.granted) fail('interactive_permission_denied', 'denied');
          if (typeof approval.validate === 'function') validations.push(approval.validate);
          guard();
          grant = { ...createPermissionGrant({ toolCallId: call.toolCallId, granted: true, scope }),
            ...(authority.policyRevision ? { policyRevision: authority.policyRevision } : {}) };
          const resolved = await materialSource.resolveInputs(draft.inputs, authority, { signal, inheritedDataLevel: dataLevel });
          dataLevel = resolved.dataLevel; guard();
          const content = await validate({ operation: 'validate', draft, bindings: resolved.bindings }, { signal });
          guard();
          const receipt = store.commitPublication({ owner: authority.owner, source: authority.source, draft, content,
            provenance: resolved.provenance, dataLevel, grant, ...(authority.streamId ? { streamId: authority.streamId } : {}) }, guard);
          return published(receipt.publicationStatus === 'published' ? receipt : reconcile(callRef));
        }
        const request = normalizeInteractiveInspect(call.arguments);
        if (!request) fail('interactive_inspect_invalid');
        if (!['project_agent', 'session_worker', 'verifier', 'visual_verifier'].includes(authority.role)
          || authority.role === 'project_agent' && !['metadata', 'text'].includes(request.view)) fail('interactive_role_denied', 'denied');
        const target = request.target;
        if (!same(target.reference.owner, authority.owner) || (target.kind === 'result'
          ? await authority.admitResult?.(target.reference) !== true : await authority.admitPublication?.(target.reference) !== true)) fail('interactive_scope_denied', 'denied');
        guard();
        grant = createPermissionGrant({ toolCallId: call.toolCallId, granted: true, scope: { capabilityId: INSPECT, target, view: request.view } });
        if (target.kind === 'publication') {
          let receipt = store.getOperation(target.reference);
          if (!receipt) fail('publication_unknown');
          try { receipt = reconcile(target.reference); } catch (error) {
            if (error.code === 'publication_index_conflict') throw error;
          }
          const committed = store.getVersion(receipt.reference, { allowPending: true });
          dataLevel = committed.dataLevel; guard();
          return result({ kind: 'interactive_publication_status', callRef: target.reference, publicationStatus: receipt.publicationStatus,
            reference: receipt.reference, effectCommitted: true, ...(receipt.publicationStatus !== 'published' ? { recovery: 'reconcile_only' } : {}) });
        }
        const fixed = store.getVersion(target.reference), content = fixed.content;
        dataLevel = fixed.dataLevel;
        const base = { kind: 'interactive_inspection', reference: fixed.reference, specHash: content.specHash, view: request.view,
          dataLevel, source: fixed.source, evidenceRef: fixed.evidenceRef };
        const sources = fixed.provenance.map(({ bindingId, source, contentVersion, observedAt, truncated, redacted, dataLevel }) => ({ bindingId, source, contentVersion, observedAt, truncated, redacted, dataLevel }));
        let output;
        if (request.view === 'metadata') output = { ...base, title: content.title, publicationStatus: 'published', sources, ...(fixed.predecessor ? { predecessor: fixed.predecessor } : {}) };
        else if (request.view === 'text') output = { ...base, classification: 'model-text-fallback', ...page(content.textFallback, request) };
        else if (request.view === 'program') output = { ...base, classification: 'model-program', ...page(content.program, request) };
        else if (request.view === 'data') {
          if (!Object.hasOwn(content.bindings, request.bindingId)) fail('interactive_binding_unavailable');
          const selected = selectInteractiveData(content.bindings[request.bindingId], request.selector);
          const encoded = encode(selected);
          output = { ...base, bindingId: request.bindingId, source: fixed.provenance.find(item => item.bindingId === request.bindingId),
            encoding: 'canonical-json', range: request.selector ?? {}, ...page(encoded, request) };
        } else {
          let values = content.initialValues, stateSource = { kind: 'initial', values, stateDigest: jsonDigest(values) };
          if (request.followupId) {
            if (await authority.admitFollowup?.(request.followupId) !== true) fail('interactive_followup_not_admitted', 'denied');
            const followup = stateStore?.readFollowup(authority.owner, request.followupId);
            if (!followup || !same(followup.result, fixed.reference) || followup.specHash !== content.specHash) fail('interactive_followup_unavailable');
            // Selected-only conditions are useful discussion material but cannot prove a full-view evaluation.
            if (Object.keys(content.stateSchema).some(key => !Object.hasOwn(followup.values, key))) fail('followup_state_incomplete');
            values = followup.values; stateSource = { kind: 'frozen-followup', followupId: followup.followupId,
              stateRevision: followup.stateRevision, stateDigest: followup.stateDigest, values };
          }
          const evaluated = await validate({ operation: 'evaluate', content, values }, { signal });
          output = { ...base, classification: 'host-derived', stateSource, ...page(evaluated.projection.text, request),
            computationTruncated: evaluated.projection.truncated, notice: 'Pure computation is not verification of source business facts or task acceptance.' };
        }
        guard(); return result(output, { summary: `Read fixed interactive result: ${request.view}; ${fixed.reference.contentVersion}` });
      } catch (error) {
        const code = error.code ?? 'interactive_provider_failed';
        let receipt, operationUnreadable = false;
        if (callRef) { try { receipt = store.getOperation(callRef); } catch { operationUnreadable = true; } }
        const committed = !!receipt;
        const reason = operationUnreadable ? 'publication_unknown'
          : committed && receipt.publicationStatus === 'index_pending' && code !== 'publication_parameter_conflict'
            ? (code === 'publication_index_conflict' ? code : 'publication_index_pending') : code;
        const status = error.status ?? (code === 'interactive_cancelled' ? 'cancelled' : code === 'interactive_validation_timeout' ? 'timeout' : 'failed');
        const failed = createFailedClientToolResult({ call, locale, reason, status, dataLevel });
        failed.outputPreview = { ...failed.outputPreview,
          ...(call.capabilityId === PUBLISH ? { publicationStatus: operationUnreadable ? 'unknown' : committed ? receipt.publicationStatus : 'not_committed' } : {}),
          ...(committed ? { effectCommitted: true, callRef, reference: receipt.reference,
            recovery: receipt.publicationStatus === 'published' ? 'inspect_only' : 'reconcile_only' } : operationUnreadable ? { callRef, recovery: 'reconcile_only' } : {}),
          diagnostic: { code: reason, path: String(error.path ?? '').slice(0, 240), details: String(error.details ?? '').slice(0, 240), retryable: !committed && ['interactive_validation_failed', 'invalid_program', 'invalid_component'].includes(reason) } };
        return { call, grant: status === 'denied' ? { ...grant, granted: false, duration: 'denied' } : grant, result: failed };
      }
    } };
}
