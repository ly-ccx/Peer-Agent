import { projectClassicGoals, projectHistory } from '@peer-agent/runtime-node';

/** A current read batch, never an execution or permission snapshot. */
export function createClassicGoalProjection({ registry, conversationStore, goalPlanStore }) {
  function batch(workspaceIds) {
    const result = new Map(workspaceIds.map(id => [id, []]));
    if (!workspaceIds.length) return result;
    try {
      const entries = typeof registry?.list === 'function' ? registry.list() : workspaceIds.map(id => registry?.get?.(id)).filter(Boolean);
      const paths = new Map(entries.map(entry => [entry.workspaceId, entry.path]));
      const conversations = conversationStore?.listConversations?.() || [];
      const plans = goalPlanStore?.listPlans?.() || [];
      for (const id of workspaceIds) {
        const folder = paths.get(id);
        if (!folder) continue;
        const history = projectHistory(conversations, { workspacePath: folder });
        result.set(id, projectClassicGoals(plans, { workspacePath: folder, conversationIds: history.map(row => row.id) }));
      }
    } catch { /* Match the legacy optional projection's unavailable behavior. */ }
    return result;
  }
  return { batch, one: id => batch([id]).get(id) || [] };
}
