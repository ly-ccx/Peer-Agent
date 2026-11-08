import { performance } from 'node:perf_hooks';
import { delegationFactsForWorkspace } from '@peer-agent/runtime-node';
import { noteDiagnosticPhase } from '@peer-agent/runtime-node/diagnostic-phase';

/** Read current ownership metadata once; task watches never need chat bodies. */
export function createDelegationFactsReader({ conversationStore, goalPlanStore }) {
  const cache = new Map();
  return workspaceId => {
    if (typeof workspaceId !== 'string' || !workspaceId) return { sessions: [] };
    const started = performance.now();
    const conversations = conversationStore.listConversations({
      roles: ['default', 'project_agent', 'work_session'],
      includeMessageCount: false,
    });
    const ownership = new Map(conversations.map(meta => [meta.id, meta.workspaceId]));
    const metas = (goalPlanStore.listPlanMetadata?.() ?? goalPlanStore.listPlans?.() ?? [])
      .filter(meta => ownership.get(meta.conversationId) === workspaceId);
    const stamp = typeof goalPlanStore.planReadStamp === 'function'
      ? metas.map(meta => `${meta.planId}=${goalPlanStore.planReadStamp(meta.planId)}`).join('|')
      : null;
    const hit = stamp == null ? null : cache.get(workspaceId);
    if (hit && hit.stamp === stamp) {
      noteDiagnosticPhase('watch.readFacts', { hit: 1, ms: performance.now() - started, plans: metas.length });
      return hit.facts;
    }
    const plans = metas
      .map(meta => goalPlanStore.getPlan(meta.planId))
      .filter(Boolean);
    const facts = delegationFactsForWorkspace(plans, workspaceId);
    if (stamp != null) cache.set(workspaceId, { stamp, facts });
    noteDiagnosticPhase('watch.readFacts', { hit: 0, ms: performance.now() - started, plans: metas.length });
    return facts;
  };
}
