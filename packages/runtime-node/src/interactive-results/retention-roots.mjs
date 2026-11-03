import { interactiveDigest, interactiveToken, normalizeInteractiveOwner, normalizeInteractiveReference } from '@peer-agent/protocol';
import { encode, jsonDigest, problem } from './storage.mjs';

const LIMIT = 16_384;
const sync = fn => typeof fn === 'function' && fn.constructor?.name !== 'AsyncFunction';

/** Assemble real source locks. Compatibility must separately fence old writers until release. */
export function createInteractiveRetentionRoots({ acquireCompatibility, inputQueue, drafts, feedback, acquireDelegationRoots, verification } = {}) {
  return function acquireRoots(rawOwner) {
    const owner = normalizeInteractiveOwner(rawOwner);
    if (!owner || !sync(acquireCompatibility) || !sync(inputQueue?.acquireRetentionInputs)
      || !sync(drafts?.acquireRetentionDrafts) || !sync(feedback?.acquireMessageRoots)
      || !sync(acquireDelegationRoots) || !sync(verification?.acquireRetentionVerification))
      throw problem('interactive_retention_unavailable');
    const releases = [], checks = [];
    const sources = {}, pins = new Map(), followupIds = new Set();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const failures = [];
      for (const close of releases.reverse()) {
        try { close(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw Object.assign(new AggregateError(failures, 'interactive_retention_release_failed'),
        { code: 'interactive_retention_release_failed' });
    };
    function register(guard, hasRelease = true) {
      if (guard?.then) {
        Promise.resolve(guard).then(value => { try { value?.release?.(); } catch {} }, () => {});
        throw problem('interactive_retention_unavailable');
      }
      if (sync(guard?.release)) releases.push(() => guard.release());
      if (!interactiveDigest(guard?.revision) || !sync(guard?.assertCurrent) || hasRelease && !sync(guard?.release))
        throw problem('interactive_retention_unavailable');
      checks.push(() => guard.assertCurrent());
      if (guard.assertCurrent() !== true) throw problem('interactive_retention_stale');
      return guard;
    }
    function pin(source, raw, id) {
      const reference = normalizeInteractiveReference(raw);
      if (!reference || reference.owner.workspaceId !== owner.workspaceId || id !== undefined && !interactiveToken(id))
        throw problem('interactive_retention_unavailable');
      // Drafts and inputs may retain earlier Bot conversations in this workspace.
      if (reference.owner.conversationId !== owner.conversationId) {
        if (source !== 'drafts' && source !== 'inputs') throw problem('interactive_retention_unavailable');
        return;
      }
      pins.set(encode([source, reference]), { source, reference });
      if (id !== undefined) followupIds.add(id);
      if (pins.size > LIMIT || followupIds.size > LIMIT) throw problem('interactive_retention_unavailable');
    }
    function selections(source, guard) {
      sources[source] = guard.revision;
      if (!Array.isArray(guard.selections) || guard.selections.length > LIMIT) throw problem('interactive_retention_unavailable');
      for (const selection of guard.selections) {
        if (!interactiveToken(selection?.followupId)) throw problem('interactive_retention_unavailable');
        pin(source, selection.reference, selection.followupId);
      }
    }
    function targets(source, guard) {
      sources[source] = guard.revision;
      if (!Array.isArray(guard.references) || guard.references.length > LIMIT
        || !Array.isArray(guard.followupIds) || guard.followupIds.length > LIMIT) throw problem('interactive_retention_unavailable');
      for (const ref of guard.references) pin(source, ref);
      for (const id of guard.followupIds) {
        if (!interactiveToken(id)) throw problem('interactive_retention_unavailable');
        followupIds.add(id);
        if (followupIds.size > LIMIT) throw problem('interactive_retention_unavailable');
      }
    }
    try {
      const compatibility = register(acquireCompatibility(owner));
      // Active view pins are read and hashed inside the result transaction.
      sources.views = jsonDigest(['interactive-active-view', compatibility.revision]);
      const savedDrafts = register(drafts.acquireRetentionDrafts(owner.workspaceId));
      const queuedInputs = register(inputQueue.acquireRetentionInputs(owner.workspaceId));
      selections('drafts', savedDrafts);
      selections('inputs', queuedInputs);
      const messages = register(feedback.acquireMessageRoots(owner));
      selections('messages', messages);
      const delegation = register(acquireDelegationRoots(owner, messages), false);
      targets('delegation', delegation);
      const review = register(verification.acquireRetentionVerification(owner));
      targets('verification', review);
      const assertCurrent = () => !released && checks.every(check => check() === true);
      if (!assertCurrent()) throw problem('interactive_retention_stale');
      const materialResponsibility = ({ owner: expectedOwner, source }) => {
        if (!assertCurrent() || encode(expectedOwner) !== encode(owner)) throw problem('interactive_retention_stale');
        if (!sync(messages.hasMaterialSource) || !Number.isSafeInteger(delegation.unsettledPlans) || delegation.unsettledPlans < 0)
          throw problem('interactive_retention_unavailable');
        let pendingAttachment = false;
        if (source.kind === 'user-material') {
          const sources = [savedDrafts.attachmentIds, queuedInputs.attachmentIds];
          if (sources.some(ids => !Array.isArray(ids) || ids.length > LIMIT || ids.some(id => !interactiveToken(id))))
            throw problem('interactive_retention_unavailable');
          pendingAttachment = sources.some(ids => ids.includes(source.attachmentId));
        }
        const blocked = pendingAttachment || delegation.unsettledPlans > 0
          || review.references.length > 0 || review.followupIds.length > 0 || messages.hasMaterialSource(source);
        const digest = jsonDigest([sources, source, blocked]);
        return { digest, blocked, assertCurrent, release() {} };
      };
      return { sources, pins: [...pins.values()], followupIds: [...followupIds], materialResponsibility, assertCurrent, release };
    } catch (error) { release(); throw error; }
  };
}
