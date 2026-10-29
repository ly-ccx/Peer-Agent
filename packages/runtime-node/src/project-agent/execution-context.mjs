

export function executionView(context) {
  const nested = context?.toolContext && typeof context.toolContext === 'object' && !Array.isArray(context.toolContext)
    ? context.toolContext
    : {};
  return {
    coordinationBinding: context?.turnProfile?.coordinationBinding ?? nested.turnProfile?.coordinationBinding,
    workId: text(context?.turnProfile?.workId) || text(nested.turnProfile?.workId),
    sessionId: text(context?.turnProfile?.sessionId) || text(nested.turnProfile?.sessionId),
    planId: text(context?.turnProfile?.planId) || text(nested.turnProfile?.planId),
    agentKind: context?.turnProfile?.agentKind ?? nested.turnProfile?.agentKind,
    turnKind: context?.turnProfile?.context?.turnKind ?? nested.turnProfile?.context?.turnKind,
    manualCriterionAuthorities: context?.manualCriterionAuthorities ?? nested.manualCriterionAuthorities,
    mode: context?.mode ?? nested.mode,
    role: context?.role ?? context?.turnProfile?.role ?? nested.role ?? nested.turnRole ?? nested.turnProfile?.role,
    messages: Array.isArray(context?.messages) ? context.messages : nested.messages,
    quoteRefs: context?.quoteRefs ?? nested.quoteRefs,
    replyTo: context?.replyTo ?? nested.replyTo,
    turnId: text(context?.turnId) || text(nested.turnId) || '',
    toolCallOrdinal: context?.toolCallOrdinal ?? nested.toolCallOrdinal ?? '',
    workspaceId: text(context?.workspaceId) || text(nested.workspaceId),
    workspacePath: text(context?.workspacePath) || text(nested.workspacePath) || '',
    surface: context?.surface ?? nested.surface,
    conversationId: text(context?.conversationId) || text(nested.conversationId),
    memoryIds: idList(context?.turnMemoryIds ?? nested.turnMemoryIds),
    currentInputAnchors: idList(context?.currentInputAnchors ?? nested.currentInputAnchors),
    objectiveWakeIds: idList(context?.objectiveWakeIds ?? nested.objectiveWakeIds),
    sessionWakeIds: idList(context?.sessionWakeIds ?? nested.sessionWakeIds),
    objectiveWakeEvents: Array.isArray(context?.objectiveWakeEvents ?? nested.objectiveWakeEvents) ? structuredClone(context?.objectiveWakeEvents ?? nested.objectiveWakeEvents) : [],
    events: context?.turnProfile?.context?.events ?? nested.turnProfile?.context?.events ?? [],
    turnToolCalls: Array.isArray(context?.turnToolCalls)
      ? context.turnToolCalls.slice()
      : (Array.isArray(nested.turnToolCalls) ? nested.turnToolCalls.slice() : []),
  };
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    const id = text(item);
    if (!id || id.length > 200 || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= 200) break;
  }
  return ids;
}

export function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
