const BODY_BUDGET = 12_000;

/** Admit execution snapshots as bounded factual input, never as instructions. */
export function verifierEvidenceSnapshots(plan, records = []) {
  const refs = new Set((plan?.criterionResults || []).map(row => row.evidenceRef).filter(Boolean));
  function visit(tasks) {
    for (const task of tasks || []) {
      for (const ref of task.evidenceRefs || []) refs.add(ref);
      visit(task.subtasks);
    }
  }
  visit(plan?.tasks);
  const indexed = new Map();
  for (const record of records) {
    const owned = record?.planId ? record.planId === plan?.planId
      : plan?.conversationId && record?.conversationId === plan.conversationId;
    if (!refs.has(record?.evidenceRef) || !owned) continue;
    if (!['file', 'command'].includes(record.bodyPreview?.kind) || typeof record.bodyPreview.text !== 'string') continue;
    indexed.set(record.evidenceRef, record);
  }
  let remaining = BODY_BUDGET;
  const snapshots = [];
  for (const evidenceRef of refs) {
    if (!remaining) break;
    const record = indexed.get(evidenceRef);
    if (!record) continue;
    const text = record.bodyPreview.text.slice(0, Math.min(4000, remaining));
    if (!text) continue;
    remaining -= text.length;
    snapshots.push({ evidenceRef, toolName: record.toolName, kind: record.bodyPreview.kind, text,
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
      truncated: record.bodyPreview.truncated === true || text.length < record.bodyPreview.text.length });
  }
  return snapshots;
}

/** Host-owned delivery receipts prove communication, never claims in message text. */
export function verifierCommunicationSnapshots(plan, childMessages = [], parentMessages = []) {
  const origin=plan?.delegationOrigin;
  if (!origin?.sessionId || !origin.workspaceId || !origin.parentConversationId || !plan.conversationId) return [];
  const receipts=new Map();
  for (const [messages,direction,sender,recipient] of [
    [parentMessages,'child_to_parent',plan.conversationId,origin.parentConversationId],
    [childMessages,'parent_to_child',origin.parentConversationId,plan.conversationId],
  ]) {
    for (const row of messages) {
      const message=row?.agentMessage;
      if (row?.kind!=='agent_message' || row.id!==message?.messageId
        || message.workspaceId!==origin.workspaceId || message.sessionId!==origin.sessionId
        || message.direction!==direction || message.senderConversationId!==sender || message.recipientConversationId!==recipient
        || !['question','answer','update'].includes(message.purpose) || typeof message.text!=='string'
        || !Number.isFinite(Date.parse(message.at))) continue;
      receipts.set(message.messageId,message);
    }
  }
  let remaining=BODY_BUDGET;
  return [...receipts.values()].filter(message=> {
    if (message.purpose!=='answer') return true;
    const question=receipts.get(message.replyTo);
    return message.direction==='parent_to_child' && question?.purpose==='question'
      && question.direction==='child_to_parent' && Date.parse(question.at)<=Date.parse(message.at);
  }).sort((a,b)=>a.at.localeCompare(b.at)).slice(-8).flatMap(message=> {
    if (!remaining) return [];
    const text=JSON.stringify({messageId:message.messageId,workspaceId:message.workspaceId,sessionId:message.sessionId,
      senderConversationId:message.senderConversationId,recipientConversationId:message.recipientConversationId,
      at:message.at,direction:message.direction,purpose:message.purpose,replyTo:message.replyTo,text:message.text});
    const admitted=text.slice(0,Math.min(4000,remaining));remaining-=admitted.length;
    // Task evidence may also cite the raw message ID. Keep the host delivery
    // provenance distinct, inside the same existing EvidenceIndex.
    const evidenceRef=`agent-delivery://${encodeURIComponent(plan.planId)}/${encodeURIComponent(message.messageId)}`;
    return [{evidenceRef,kind:'communication',toolName:'send_agent_message',createdAt:message.at,
      text:admitted,truncated:admitted.length<text.length}];
  });
}

/** Register validated host delivery facts in the existing index before semantic review. */
export function admitVerifierCommunicationEvidence(plan, goalPlanStore, childMessages = [], parentMessages = []) {
  if (typeof goalPlanStore?.recordEvidenceRefs !== 'function') return [];
  const indexed = new Map((goalPlanStore.listEvidenceIndex?.() || []).map(row => [row.evidenceRef, row]));
  return verifierCommunicationSnapshots(plan, childMessages, parentMessages).filter(snapshot => {
    const previous = indexed.get(snapshot.evidenceRef);
    // Stable receipt identities cannot be rebound to a different work or conversation.
    if (previous && (previous.planId !== plan.planId || previous.conversationId !== plan.conversationId
      || previous.capabilityId !== 'local.delegation.send_agent_message')) return false;
    if (!previous) goalPlanStore.recordEvidenceRefs({
      planId: plan.planId, conversationId: plan.conversationId, evidenceRef: snapshot.evidenceRef,
      capabilityId: 'local.delegation.send_agent_message', toolName: snapshot.toolName, createdAt: snapshot.createdAt,
    });
    return true;
  });
}
