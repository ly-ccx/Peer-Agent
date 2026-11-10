import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from '../sqlite/connection.mjs';
import { canonicalGrantKey, obligationIdFor, OBLIGATION_FORMAT_VERSION } from './execution-obligation-kernel.mjs';
import { proveRecorder, recorderComplete } from './execution-recorder.mjs';
import { appendObligationLog } from './obligation-log.mjs';
import { unsettledExecution } from './execution-resources.mjs';
import { sessionFactsFromPlan } from './session-facts.mjs';
import { executionIdentity, sameExecution } from './session-control-kernel.mjs';

const REFUSALS = new Set(['execution_stop_unconfirmed', 'execution_outcome_unknown', 'reconcile_execution_outcome']);
const GRANT_MS = 15 * 60 * 1000;
const ACTIONS = new Set(['retire_follow_up', 'acknowledge_unknown', 'restore_follow_up', 'close_claim']);

function revisionPrefix(value) {
  return typeof value === 'string' && value ? value.slice(0, 12) : null;
}
function staleItems(requested, present) {
  const stale = [];
  for (const item of requested) {
    const row = present.find(candidate => candidate.sessionId === item.sessionId);
    if (!row) {
      stale.push({ obligationId: item.obligationId || null, sessionId: item.sessionId || null, reason: 'item_missing', revision: null });
      continue;
    }
    if (item.obligationId !== row.obligationId) {
      stale.push({ obligationId: row.obligationId, sessionId: row.sessionId, reason: 'obligation_mismatch', revision: revisionPrefix(row.evidenceRevision) });
      continue;
    }
    if (item.evidenceRevision !== row.evidenceRevision) {
      stale.push({ obligationId: row.obligationId, sessionId: row.sessionId, reason: 'evidence_revision', revision: revisionPrefix(row.evidenceRevision) });
    }
  }
  return stale;
}
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function claimsFor(scheduler, plan) {
  return (scheduler?.resourceSnapshot?.() || []).filter(row => sameExecution(row.execution, executionIdentity(plan)));
}
function openHandles(claims) {
  return claims.flatMap(claim => Object.values(claim.handles || {}).filter(handle => handle.state !== 'ended').map(handle => handle.handleId || handle.toolCallId)).filter(Boolean).sort();
}
const RECORDER_FIELDS = ['bootId', 'pid', 'pidStart', 'hostId', 'acquiredAt'];
function missingRecorderFields(recorder) {
  if (!recorder || typeof recorder !== 'object') return [...RECORDER_FIELDS];
  return RECORDER_FIELDS.filter(name => {
    const value = recorder[name];
    if (name === 'pid') return !Number.isSafeInteger(value) || value <= 0;
    return typeof value !== 'string' || !value;
  });
}

function obligationDirectory(rootDir, workspaceId) {
  return rootDir && workspaceId ? path.join(rootDir, workspaceId) : '';
}

/** Read pending grants from the durable index. A missing runtime binding is not an empty list. */
export function readPersistedObligationGrants({ rootDir, workspaceId }) {
  const directory = obligationDirectory(rootDir, workspaceId);
  if (!directory) return { ok: false, code: 'obligation_store_unreadable', cause: 'obligation_store_unreadable' };
  if (!existsSync(directory)) return { ok: true, grants: [], source: 'absent' };
  const pointerFile = path.join(directory, '.read-models', 'coordination-current.json');
  const ledger = existsSync(path.join(directory, 'coordination-v2')) || existsSync(path.join(directory, 'coordination.jsonl'));
  if (!existsSync(pointerFile)) {
    return ledger
      ? { ok: false, code: 'obligation_store_unreadable', cause: 'coordination_index_missing' }
      : { ok: true, grants: [], source: 'absent' };
  }
  let pointer;
  try { pointer = JSON.parse(readFileSync(pointerFile, 'utf8')); }
  catch { return { ok: false, code: 'obligation_store_unreadable', cause: 'coordination_index_corrupt' }; }
  if (pointer?.schemaVersion !== 1 || !/^coordination-[a-f0-9-]{36}\.sqlite$/.test(pointer.file || '')) {
    return { ok: false, code: 'obligation_store_unreadable', cause: 'coordination_index_corrupt' };
  }
  const file = path.join(directory, '.read-models', pointer.file);
  if (!existsSync(file)) return { ok: false, code: 'obligation_store_unreadable', cause: 'coordination_index_missing' };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("SELECT value FROM objects WHERE bucket = 'obligationGrants'").all();
    const grants = rows.map(row => JSON.parse(row.value)).filter(grant => grant?.status === 'pending');
    return { ok: true, grants, source: 'persisted' };
  } catch (error) {
    return { ok: false, code: 'obligation_store_unreadable', cause: error?.code || 'obligation_store_unreadable' };
  } finally {
    try { db?.close(); } catch { /* closing a failed read must not hide the error */ }
  }
}

/** Another bot's grant stays hidden. A legacy grant with no parent is visible only when this bot owns a listed session. */
export function selectPendingGrants(grants, { parentConversationId, ownsSession } = {}) {
  const kept = [];
  const decisions = [];
  for (const grant of grants || []) {
    const parent = typeof grant?.principal?.parentConversationId === 'string' ? grant.principal.parentConversationId : '';
    if (!parentConversationId || parent === parentConversationId) {
      kept.push(grant);
      decisions.push({ grantId: grant.grantId, reason: parent ? 'parent_match' : 'unscoped' });
      continue;
    }
    if (!parent && ownsSession?.(grant) === true) {
      kept.push(grant);
      decisions.push({ grantId: grant.grantId, reason: 'legacy_session_owner' });
      continue;
    }
    decisions.push({ grantId: grant.grantId || null, reason: parent ? 'parent_mismatch' : 'legacy_unverified' });
  }
  return { grants: kept, decisions };
}

const GRANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Display-only label. It is not written back onto the grant or its evidence. */
export function obligationDisplayTitle(item, projectedTitle) {
  const stored = typeof item?.title === 'string' ? item.title.trim() : '';
  const projected = typeof projectedTitle === 'string' ? projectedTitle.trim() : '';
  const usable = value => Boolean(value) && value !== item?.sessionId && !GRANT_UUID.test(value);
  if (usable(stored)) return { title: stored, shortId: null };
  if (usable(projected)) return { title: projected, shortId: null };
  const compact = String(item?.sessionId || '').replace(/[^0-9a-f]/gi, '');
  return { title: null, shortId: (compact || 'unknown').slice(0, 8) };
}

export function classifyExecutionObligation({ plan, control, claims = [], identity, writerEpoch, disposition }) {
  const ownership = sessionFactsFromPlan(plan).executionOwnership;
  const proof = proveRecorder(control?.recorder, identity);
  const unknownCallIds = [...new Set(unsettledExecution(plan))].sort();
  const openHandleIds = openHandles(claims);
  const registrationAbsent = unknownCallIds.length === 0 && openHandleIds.length === 0 && !control?.stopReceipt;
  const stableRefusal = control?.phase === 'reconciling' && REFUSALS.has(control?.nextAction);
  const barrier = control && ['recorded', 'draining'].includes(control.phase) && !stableRefusal;
  const classes = [];
  const gaps = [];
  if (control?.phase === 'settled' && control.outcome === 'applied' && control.stopReceipt && ownership !== 'live') classes.push('managed_stop_settled');
  if (barrier) classes.push('barrier_in_progress');
  if (!recorderComplete(control?.recorder)) {
    classes.push('legacy_recorder_unproven');
    gaps.push('no_recorder_tuple');
  }
  if (control?.hostEpoch && writerEpoch && control.hostEpoch !== writerEpoch) {
    classes.push('cross_host_unproven');
    gaps.push('host_epoch_mismatch');
  }
  if (ownership === 'unknown') gaps.push('ownership_unknown');
  if (proof === 'alive' || ownership === 'live') classes.push(ownership === 'live' ? 'execution_still_running' : 'recorder_alive');
  if (proof === 'dead' || proof === 'reused' || proof === 'different_boot') {
    // A missing dispatch registration is an unknown effect. Death alone is not "clear".
    const effectUnknown = unknownCallIds.length > 0 || openHandleIds.length > 0 || registrationAbsent;
    classes.push(effectUnknown ? 'recorder_dead_with_unknown' : 'recorder_dead_clear');
  }
  if (unknownCallIds.length || openHandleIds.length || registrationAbsent && !control?.stopReceipt) {
    if (unknownCallIds.length || openHandleIds.length || registrationAbsent) classes.push('external_effect_unknown');
  }
  if (registrationAbsent && !control?.stopReceipt) gaps.push('dispatch_registration_absent');
  if (unknownCallIds.length) gaps.push('unknown_calls');
  if (openHandleIds.length) gaps.push('open_handles');
  const remote = typeof plan?.runner?.lastError === 'string' && /401|timeout|timed out/i.test(plan.runner.lastError);
  if (remote && proof !== 'dead' && proof !== 'reused' && proof !== 'different_boot') {
    classes.push('remote_unobserved');
    gaps.push('remote_signal_not_death');
  }
  const unique = [...new Set(classes)];
  const claim = claims[0];
  // A closure ends one claim, not a live execution and not a remote-unfenced effect.
  const closeable = Boolean(claim && ['draining', 'reconciling'].includes(claim.state)
    && ownership !== 'live' && proof !== 'alive' && !barrier
    && !unique.includes('managed_stop_settled') && !unique.includes('recorder_dead_clear')
    && !unique.includes('remote_unobserved') && !openHandleIds.length);
  const allowed = allowedActions({ classes: unique, disposition, ownership, proof, barrier, closeable });
  return { classes: unique, gaps: [...new Set(gaps)], missingFields: missingRecorderFields(control?.recorder), unknownCallIds, openHandleIds, ownership, proof, allowed, closeable, registrationAbsent, stableRefusal, barrier };
}

function allowedActions({ classes, disposition, ownership, proof, barrier, closeable }) {
  if (barrier || classes.includes('managed_stop_settled') || classes.includes('recorder_dead_clear')) return [];
  if (ownership === 'live' || proof === 'alive' || classes.includes('recorder_alive') || classes.includes('execution_still_running')) return [];
  if (disposition === 'indexed') return closeable ? ['restore_follow_up', 'acknowledge_unknown', 'close_claim'] : ['restore_follow_up'];
  return closeable ? ['retire_follow_up', 'acknowledge_unknown', 'close_claim'] : ['retire_follow_up', 'acknowledge_unknown'];
}

function evidenceBody({ control, claims, classification, writerEpoch }) {
  return {
    operationId: control?.operationId || null,
    revision: control?.revision || 0,
    nextAction: control?.nextAction || null,
    hasReceipt: Boolean(control?.stopReceipt),
    claims: claims.map(claim => ({ claimId: claim.claimId, revision: claim.revision, state: claim.state })).sort((a, b) => a.claimId.localeCompare(b.claimId)),
    unknownCallIds: classification.unknownCallIds,
    openHandleIds: classification.openHandleIds,
    ownership: classification.ownership,
    hostEpochMismatch: Boolean(control?.hostEpoch && writerEpoch && control.hostEpoch !== writerEpoch),
    recorderComplete: recorderComplete(control?.recorder),
    proof: classification.proof,
  };
}

export function createExecutionObligationService({ plans, readControl, scheduler, canManage, storeFor, identity, writerEpochFor, onChanged = null, recordClosure = null, unknownOutcome = null, now = () => new Date().toISOString() }) {
  const clock = () => Date.parse(now());
  function store(workspaceId) { return storeFor(workspaceId); }
  function dispositionFor(workspaceId, sessionId) {
    const snap = store(workspaceId)?.read?.() || {};
    const id = snap.obligationHeads?.[sessionId];
    return id ? snap.obligationDispositions?.[id] : undefined;
  }
  function view(plan, audience) {
    const origin = plan.delegationOrigin;
    const control = readControl(plan);
    const claims = claimsFor(scheduler, plan);
    const writerEpoch = writerEpochFor?.(origin.workspaceId);
    const disposition = dispositionFor(origin.workspaceId, origin.sessionId)?.phase;
    const classification = classifyExecutionObligation({ plan, control, claims, identity: identity(), writerEpoch, disposition });
    const evidenceRevision = digest(evidenceBody({ control, claims, classification, writerEpoch }));
    const claim = claims[0];
    // ADR 127 UO-06: advisory unknown-outcome facts for the ask card and task detail.
    // They describe evidence and policy; they are never part of the authorization digest.
    const outcomeFacts = claim && unknownOutcome?.inspect ? (() => {
      try { const row = unknownOutcome.inspect(plan, { claimId: claim.claimId }); return row?.ok ? row : null; } catch { return null; }
    })() : null;
    const obligationId = obligationIdFor({ workspaceId: origin.workspaceId, sessionId: origin.sessionId, planId: plan.planId, operationId: control?.operationId || origin.cancellation?.operationId || '' });
    return {
      sessionId: origin.sessionId, planId: plan.planId, operationId: control?.operationId || null, obligationId,
      title: typeof plan.title === 'string' && plan.title.trim() ? plan.title.trim().slice(0, 200) : origin.sessionId,
      classes: classification.classes,
      cancelIntent: { state: control?.phase === 'settled' && control.outcome === 'applied' ? 'settled' : 'open', phase: control?.phase || null, revision: control?.revision || 0 },
      liveness: classification.proof === 'alive' ? 'recorder_alive' : classification.proof === 'dead' || classification.proof === 'reused' ? 'recorder_dead' : classification.ownership === 'live' ? 'live' : classification.ownership === 'ended' ? 'ended' : 'recorder_unproven',
      livenessFreshness: 'advisory',
      outcome: { registration: classification.registrationAbsent ? 'registration_absent' : 'registered', unknownCallIds: classification.unknownCallIds, openHandleIds: classification.openHandleIds },
      ...(outcomeFacts ? { unknownOutcome: { policyTier: outcomeFacts.policyTier, reconciliation: outcomeFacts.eligible
        ? { eligible: true, verdict: outcomeFacts.verdict, evidenceDigest: outcomeFacts.evidenceDigest }
        : { eligible: false, reason: outcomeFacts.reason } } } : {}),
      resource: claim ? { claimId: claim.claimId, revision: claim.revision, state: claim.state,
        resourceKind: claim.resourceRef?.startsWith('file:') ? 'file' : 'directory', ...(claim.scope ? { scope: claim.scope } : {}) } : null,
      gaps: classification.gaps,
      missingFields: classification.missingFields,
      evidenceRevision, observedAt: now(),
      allowedActions: classification.allowed,
      refusalPreview: classification.barrier ? ['barrier_in_progress'] : classification.proof === 'alive' || classification.ownership === 'live' ? ['recorder_alive'] : [],
      planStatus: plan.status,
      closeClaimAvailable: classification.closeable,
      recorderProof: classification.proof,
      display: { willBeMarkedCancelled: false, resourceWillRemain: true },
      parentConversationId: origin.parentConversationId, workspaceId: origin.workspaceId,
      audience, disposition: disposition || null,
      controlRevision: control?.revision || 0, claimRevision: claim?.revision || 0,
    };
  }
  function scoped(input) {
    const workspaceId = input.workspaceId, parent = input.parentConversationId;
    if (!canManage(workspaceId)) return { error: 'lease_unavailable' };
    const wanted = new Set([...(input.sessionIds || []), ...(input.obligationIds || [])]);
    if (!wanted.size) return { error: 'obligation_scope_empty' };
    if (wanted.size > 20) return { error: 'too_many_items' };
    const items = [];
    for (const id of wanted) {
      const plan = [...plans()].find(row => row.delegationOrigin?.workspaceId === workspaceId
        && (row.delegationOrigin.sessionId === id || dispositionFor(workspaceId, row.delegationOrigin.sessionId)?.obligationId === id));
      if (!plan || parent && plan.delegationOrigin.parentConversationId !== parent) items.push({ id, error: 'out_of_scope' });
      else items.push(view(plan, input.agentConversationId));
    }
    return { items };
  }
  function writable(workspaceId) {
    const target = store(workspaceId);
    if (typeof target?.read !== 'function' || typeof target?.writeObligation !== 'function') throw new Error('obligation_storage_unavailable');
    return target;
  }
  function write(workspaceId, entry) {
    writable(workspaceId).writeObligation(entry);
  }
  function grantsOf(workspaceId) {
    return writable(workspaceId).read()?.obligationGrants || {};
  }
  function notify(workspaceId, grantId, status) {
    try { onChanged?.({ workspaceId, grantId: grantId || null, status: status || null }); }
    catch { /* A renderer event must not change the grant result. */ }
  }
  return {
    dispositionFor: (workspaceId, sessionId) => dispositionFor(workspaceId, sessionId)?.phase,
    pendingGrants(workspaceId, parentConversationId) {
      const grants = Object.values(store(workspaceId)?.read?.()?.obligationGrants || {});
      return grants.filter(grant => grant.status === 'pending'
        && (!parentConversationId || grant.principal?.parentConversationId === parentConversationId));
    },
    inspect(input) {
      if (input.role && input.role !== 'project_agent' && input.actor !== 'user_panel') {
        appendObligationLog({ event: 'inspect', role: input.role || null, actor: input.actor || null, ok: false, code: 'not_main_bot' });
        return { ok: false, error: 'not_main_bot' };
      }
      const found = scoped(input);
      if (found.error) {
        appendObligationLog({ event: 'inspect', role: input.role || null, actor: input.actor || null, ok: false, code: found.error });
        return { ok: false, error: found.error };
      }
      for (const item of found.items) {
        appendObligationLog({ event: 'inspect', role: input.role || null, actor: input.actor || null, ok: !item.error,
          obligationId: item.obligationId || item.id || null, code: item.error || null,
          classes: item.classes || [], gaps: item.gaps || [], missing: item.missingFields || [],
          disposition: item.disposition || (item.error ? null : 'none') });
      }
      return { ok: true, observedAt: now(), items: found.items };
    },
    requestAuthorization(input) {
      if (input.role && input.role !== 'project_agent') return { ok: false, error: 'not_main_bot' };
      const requested = input.items || [];
      if (!requested.length) return { ok: false, error: 'obligation_scope_empty' };
      if (requested.length > 20) return { ok: false, error: 'too_many_items' };
      if (requested.some(item => !item.actions?.every(action => ACTIONS.has(action)) || item.actions.includes('release_resource'))) return { ok: false, error: 'action_unavailable' };
      const fresh = this.inspect({ ...input, sessionIds: [...new Set(requested.map(item => item.sessionId))] });
      if (!fresh.ok) return fresh;
      const present = fresh.items.filter(item => !item.error);
      const stale = staleItems(requested, present);
      if (stale.length) {
        appendObligationLog({ event: 'authorize', role: input.role || null, ok: false, code: 'evidence_stale',
          obligationId: stale.map(item => item.obligationId).filter(Boolean),
          reason: stale.map(item => item.reason),
          revision: stale.map(item => item.revision).filter(Boolean) });
        return { ok: false, error: 'evidence_stale', nextTool: 'inspect_execution_obligation',
          message: 'Evidence changed. Call inspect_execution_obligation again and copy each item obligationId, sessionId, operationId, evidenceRevision, and allowedActions. Do not call cancel_session.',
          stale: stale.map(({ obligationId, sessionId, reason }) => ({ obligationId, sessionId, reason })) };
      }
      const card = [];
      const rejected = [];
      for (const item of requested) {
        const row = present.find(candidate => candidate.sessionId === item.sessionId);
        if (!row) { rejected.push({ sessionId: item.sessionId, error: 'out_of_scope' }); continue; }
        if (item.operationId !== row.operationId) { rejected.push({ sessionId: item.sessionId, error: 'authorization_mismatch' }); continue; }
        if (row.refusalPreview.length || item.actions.some(action => !row.allowedActions.includes(action))) {
          rejected.push({ sessionId: item.sessionId, error: row.refusalPreview[0] || 'action_unavailable' }); continue;
        }
        if (row.gaps.some(gap => ['unknown_calls', 'open_handles', 'dispatch_registration_absent', 'no_recorder_tuple'].includes(gap))
          && (item.actions.includes('retire_follow_up') || item.actions.includes('close_claim')) && !item.actions.includes('acknowledge_unknown')) {
          rejected.push({ sessionId: item.sessionId, error: 'unknown_not_acknowledged' }); continue;
        }
        if (item.actions.includes('restore_follow_up') && row.disposition !== 'indexed') { rejected.push({ sessionId: item.sessionId, error: 'not_indexed' }); continue; }
        card.push({ ...row, actions: [...item.actions] });
      }
      if (!card.length) return { ok: false, error: rejected[0]?.error || 'action_unavailable', items: rejected };
      const grantId = randomUUID();
      const closes = card.some(item => item.actions.includes('close_claim'));
      const stored = { grantId, status: 'pending', canonicalKey: null, items: card.map(item => ({
        sessionId: item.sessionId, operationId: item.operationId, actions: item.actions, evidenceRevision: item.evidenceRevision,
        controlRevision: item.controlRevision, claimRevision: item.claimRevision,
        title: typeof item.title === 'string' ? item.title.slice(0, 200) : item.sessionId,
        gaps: Array.isArray(item.gaps) ? item.gaps.filter(gap => typeof gap === 'string').slice(0, 12) : [],
      })), consequences: { willBeMarkedCancelled: false, resourceWillRemain: !closes, requiresAcknowledge: true, retainsUnknown: closes },
        principal: { workspaceId: input.workspaceId, parentConversationId: input.parentConversationId },
        audience: input.agentConversationId || null, revision: 1, updatedAt: now() };
      write(input.workspaceId, { kind: 'obligation_grant', minimumExecutorVersion: OBLIGATION_FORMAT_VERSION, grant: stored });
      appendObligationLog({ event: 'authorize', role: input.role || null, grantId, status: 'pending',
        obligationId: card.map(item => item.obligationId).join(','), disposition: card.map(item => item.disposition || 'none').join(',') });
      notify(input.workspaceId, grantId, 'pending');
      return { ok: true, grantId, status: 'pending', idempotencyKey: `panel-${grantId}`, items: card, rejected, consequences: {
        willBeMarkedCancelled: false, resourceWillRemain: !closes, requiresAcknowledge: true, retainsUnknown: closes,
      } };
    },
    confirm(input) {
      if (input.actor !== 'user_panel') return { ok: false, error: 'authorization_required' };
      const grant = grantsOf(input.workspaceId)[input.grantId];
      if (!grant) return { ok: false, error: 'grant_not_found' };
      if (grant.status !== 'pending') return { ok: false, error: `grant_${grant.status}` };
      if (grant.principal.workspaceId !== input.workspaceId || input.parentConversationId && grant.principal.parentConversationId !== input.parentConversationId) return { ok: false, error: 'authorization_scope_mismatch' };
      const fresh = this.inspect({ workspaceId: input.workspaceId, parentConversationId: grant.principal.parentConversationId, sessionIds: grant.items.map(item => item.sessionId), actor: 'user_panel' });
      if (grant.items.some(item => { const row = fresh.items?.find(candidate => candidate.sessionId === item.sessionId); return !row || row.error || row.evidenceRevision !== item.evidenceRevision; })) {
        write(input.workspaceId, { kind: 'obligation_grant', minimumExecutorVersion: OBLIGATION_FORMAT_VERSION, grant: { ...grant, status: 'revoked', revokedAt: now(), revision: grant.revision + 1, updatedAt: now() } });
        return { ok: false, error: 'evidence_stale' };
      }
      const confirmed = { ...grant, status: 'confirmed', confirmedAt: now(), expiresAt: new Date(clock() + GRANT_MS).toISOString(), revision: grant.revision + 1, updatedAt: now() };
      write(input.workspaceId, { kind: 'obligation_grant', minimumExecutorVersion: OBLIGATION_FORMAT_VERSION, grant: confirmed });
      appendObligationLog({ event: 'confirm', actor: input.actor || null, grantId: grant.grantId, status: 'confirmed' });
      notify(input.workspaceId, grant.grantId, 'confirmed');
      return { ok: true, grant: confirmed };
    },
    revoke(input) {
      const grant = grantsOf(input.workspaceId)[input.grantId];
      if (!grant || grant.status !== 'pending') return { ok: false, error: grant ? `grant_${grant.status}` : 'grant_not_found' };
      write(input.workspaceId, { kind: 'obligation_grant', minimumExecutorVersion: OBLIGATION_FORMAT_VERSION, grant: { ...grant, status: 'revoked', revokedAt: now(), revision: grant.revision + 1, updatedAt: now() } });
      notify(input.workspaceId, grant.grantId, 'revoked');
      return { ok: true, status: 'revoked' };
    },
    resolve(input) {
      if (input.role && input.role !== 'project_agent' && input.actor !== 'user_panel') return { ok: false, error: 'not_main_bot' };
      const grant = grantsOf(input.workspaceId)[input.grantId];
      if (!grant) return { ok: false, error: 'grant_not_found' };
      if (grant.principal.workspaceId !== input.workspaceId || input.parentConversationId && grant.principal.parentConversationId !== input.parentConversationId) return { ok: false, error: 'authorization_scope_mismatch' };
      const key = canonicalGrantKey(grant.grantId, input.items || [], input.evidenceRevision || grant.items[0]?.evidenceRevision);
      if (grant.results?.[key]) return { ok: true, grantId: grant.grantId, replayed: true, items: grant.results[key] };
      if (input.idempotencyKey && grant.canonicalKey && grant.canonicalKey !== key) return { ok: false, error: 'authorization_mismatch' };
      if (grant.status === 'pending') return { ok: false, error: 'grant_pending' };
      if (grant.status === 'revoked') return { ok: false, error: 'grant_revoked' };
      if (grant.status === 'expired' || grant.expiresAt && Date.parse(grant.expiresAt) <= clock()) {
        if (grant.status !== 'expired') write(input.workspaceId, { kind: 'obligation_grant', minimumExecutorVersion: OBLIGATION_FORMAT_VERSION, grant: { ...store(input.workspaceId).read().obligationGrants[grant.grantId], status: 'expired', revision: grant.revision + 1, updatedAt: now() } });
        return { ok: false, error: 'grant_expired' };
      }
      if (grant.status !== 'confirmed') return { ok: false, error: 'authorization_required' };
      const results = [];
      for (const item of input.items || []) {
        const bound = grant.items.find(row => row.sessionId === item.sessionId && row.operationId === item.operationId);
        if (!bound || JSON.stringify([...item.actions].sort()) !== JSON.stringify([...bound.actions].sort())) { results.push({ sessionId: item.sessionId, operationId: item.operationId, result: 'rejected', code: 'authorization_mismatch' }); continue; }
        const plan = [...plans()].find(row => row.delegationOrigin?.sessionId === item.sessionId && row.delegationOrigin.workspaceId === input.workspaceId);
        if (!plan) { results.push({ sessionId: item.sessionId, result: 'rejected', code: 'session_not_found' }); continue; }
        const current = view(plan, input.agentConversationId);
        if (current.evidenceRevision !== bound.evidenceRevision) { results.push({ ...current, result: 'rejected', code: current.claimRevision !== bound.claimRevision || current.controlRevision !== bound.controlRevision ? 'revision_conflict' : 'evidence_stale' }); continue; }
        const needsAck = current.gaps.some(gap => ['unknown_calls', 'open_handles', 'dispatch_registration_absent', 'no_recorder_tuple'].includes(gap));
        if (needsAck && (item.actions.includes('retire_follow_up') || item.actions.includes('close_claim')) && !item.actions.includes('acknowledge_unknown')) { results.push({ sessionId: item.sessionId, result: 'rejected', code: 'unknown_not_acknowledged' }); continue; }
        if (current.classes.includes('managed_stop_settled')) { results.push({ sessionId: item.sessionId, result: 'rejected', code: 'already_settled' }); continue; }
        if (item.actions.includes('restore_follow_up') && item.actions.includes('close_claim')) { results.push({ sessionId: item.sessionId, result: 'rejected', code: 'action_unavailable' }); continue; }
        if (item.actions.includes('restore_follow_up') && current.disposition !== 'indexed') { results.push({ sessionId: item.sessionId, result: 'rejected', code: 'not_indexed' }); continue; }
        let closure = null;
        if (item.actions.includes('close_claim')) {
          if (!current.closeClaimAvailable || !current.resource) { results.push({ sessionId: item.sessionId, result: 'rejected', code: 'claim_not_closeable' }); continue; }
          if (typeof scheduler.closeClaim !== 'function') { results.push({ sessionId: item.sessionId, result: 'rejected', code: 'claim_closure_unavailable' }); continue; }
          try {
            closure = scheduler.closeClaim(plan, { claimId: current.resource.claimId, claimRevision: current.resource.revision,
              authorityRef: grant.grantId, unknownCalls: current.outcome.unknownCallIds,
              proof: ['dead', 'reused', 'different_boot'].includes(current.recorderProof) ? 'verified_dead' : 'legacy_user_confirmed' });
            // Keep the GoalPlan mirror consistent so a ledger rebuild does not re-protect.
            try { recordClosure?.(plan, closure); } catch { /* the ledger closure is the authority; mirror repair follows */ }
          } catch (error) {
            results.push({ sessionId: item.sessionId, result: 'rejected', code: error.message || 'claim_closure_failed' });
            continue;
          }
        }
        const phase = item.actions.includes('restore_follow_up') ? 'current' : 'indexed';
        const previous = dispositionFor(input.workspaceId, item.sessionId);
        if (!closure && previous?.phase === phase) { results.push({ sessionId: item.sessionId, operationId: item.operationId, result: 'replayed', disposition: phase, obligationId: current.obligationId, planStatus: plan.status, stopReceipt: null, claim: current.resource, replayedTools: [] }); continue; }
        const row = { obligationId: current.obligationId, sessionId: item.sessionId, planId: current.planId, operationId: item.operationId, phase, evidenceRevision: current.evidenceRevision, revision: (previous?.revision || 0) + 1, updatedAt: now() };
        try {
          write(input.workspaceId, { kind: 'execution_obligation', minimumExecutorVersion: OBLIGATION_FORMAT_VERSION, disposition: row,
            audit: { auditId: `${grant.grantId}:${item.sessionId}:${phase}:${row.revision}`, actor: input.actor || 'main_bot', toolCallId: input.toolCallId || null,
              workspaceId: input.workspaceId, parentConversationId: input.parentConversationId, gaps: current.gaps, claim: current.resource, beforeRevision: previous?.revision || 0,
              ...(closure ? { closure } : {}) } });
          results.push({ sessionId: item.sessionId, operationId: item.operationId, result: 'applied', disposition: phase, obligationId: current.obligationId, planStatus: plan.status, stopReceipt: null,
            claim: closure ? { ...current.resource, state: 'released' } : current.resource, ...(closure ? { closure } : {}), replayedTools: [] });
        } catch (error) {
          results.push({ sessionId: item.sessionId, result: 'rejected', code: error.message || 'obligation_failed' });
        }
      }
      const saved = store(input.workspaceId).read().obligationGrants[grant.grantId];
      if (saved && !saved.results?.[key]) write(input.workspaceId, { kind: 'obligation_grant', minimumExecutorVersion: OBLIGATION_FORMAT_VERSION, grant: { ...saved, canonicalKey: key, results: { ...saved.results, [key]: results }, revision: saved.revision + 1, updatedAt: now() } });
      appendObligationLog({ event: 'resolve', actor: input.actor || null, role: input.role || null, grantId: grant.grantId,
        obligationId: results.map(item => item.obligationId).filter(Boolean).join(','),
        disposition: results.map(item => item.disposition || item.code || item.result).join(','),
        code: results.map(item => item.code).find(Boolean) || null, ok: results.every(item => item.result === 'applied' || item.result === 'replayed') });
      notify(input.workspaceId, grant.grantId, 'resolved');
      return { ok: true, grantId: grant.grantId, items: results };
    },
    suspendLive(plans) {
      for (const plan of plans) {
        const origin = plan.delegationOrigin;
        if (!origin || !canManage(origin.workspaceId)) continue;
        const current = dispositionFor(origin.workspaceId, origin.sessionId);
        if (current?.phase !== 'indexed') continue;
        if (sessionFactsFromPlan(plan).executionOwnership !== 'live' && proveRecorder(readControl(plan)?.recorder, identity()) !== 'alive') continue;
        write(origin.workspaceId, { kind: 'execution_obligation', minimumExecutorVersion: OBLIGATION_FORMAT_VERSION, disposition: { ...current, phase: 'suspended', revision: current.revision + 1, updatedAt: now() } });
      }
    },
  };
}
