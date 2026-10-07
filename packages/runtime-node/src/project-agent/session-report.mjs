const text = value => typeof value === 'string' ? value.trim() : '';

function completedLeaves(tasks) {
  const leaves = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (Array.isArray(task?.subtasks) && task.subtasks.length) leaves.push(...completedLeaves(task.subtasks));
    else if (task?.status === 'completed' && text(task.result)) leaves.push(task);
  }
  return leaves;
}

function visibleResult(message) {
  // Persisted content may concatenate narration around tools. Prefer the last
  // visible text segment; never project thinking or tool claims as a report.
  const segments = Array.isArray(message?.segments) ? message.segments : [];
  const last = segments.findLast(segment => segment?.type === 'text' && text(segment.content));
  return last ? text(last.content) : segments.length ? '' : text(message?.content);
}

/** Project actual worker output separately from host verification and requirements. */
export function buildSessionReport(plan, session, history) {
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  const worker = messages.findLast(message => message?.role === 'assistant' && !message._compaction && visibleResult(message));
  const leaves = completedLeaves(plan.tasks);
  const findings = leaves.map(task => text(task.result));
  const summary = worker ? visibleResult(worker) : findings.join('\n\n');
  const evidenceRefs = new Set([
    ...(Array.isArray(plan.evidenceRefs) ? plan.evidenceRefs : []),
    ...(Array.isArray(plan.criterionResults) ? plan.criterionResults.map(result => result?.evidenceRef) : []),
    ...leaves.flatMap(task => Array.isArray(task.evidenceRefs) ? task.evidenceRefs : []),
  ].map(text).filter(Boolean));
  const changedFiles = (Array.isArray(plan.involvedFiles) ? plan.involvedFiles : []).flatMap(item => {
    const filePath = text(typeof item === 'string' ? item : item?.path);
    return filePath ? [{ path: filePath, summary: text(item?.summary) }] : [];
  });
  return {
    sessionId: session.sessionId,
    planId: plan.planId,
    status: session.status,
    summary,
    taskBrief: text(plan.goal),
    keyFindings: findings,
    changedFiles,
    evidenceRefs: [...evidenceRefs],
    ...(summary ? { contentSource: {
      kind: worker ? 'worker_message' : 'task_results',
      ...(worker ? { conversationId: plan.conversationId, messageId: worker.id } : {}),
      verification: 'unverified',
    } } : {}),
  };
}
