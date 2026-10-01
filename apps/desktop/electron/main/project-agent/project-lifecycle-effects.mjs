/** Persist project lifecycle facts and settle results only after a visible reply exists. */
export function createProjectLifecycleEffects({ profileStore, lifecycle, supervisor, conversationStore, resolveConversationId, broadcast, resolveEvidence, objectiveService=null }) {
  return {
    onInputsConsumed: (workspaceId, inputs) => {
      objectiveService?.consumeAnswers(workspaceId,inputs.map(input=>`input-${input.inputId}`));
      if (profileStore.read(workspaceId)?.familiarize?.kind !== 'blank') return;
      const input = inputs.find((item) => item.text?.trim() && !item.answerTo);
      if (input) lifecycle.acceptResponsibility(workspaceId, { text: input.text, anchorMessageId: `input-${input.inputId}` });
    },
    onReplied: async (workspaceId, message) => {
      let replyMeta = message.meta;
      const familiar = profileStore.read(workspaceId)?.familiarize;
      if (familiar?.sessionId && !familiar.memoryRecorded && message.sources?.includes(familiar.sessionId)) {
        const decision = supervisor.acceptance(familiar.sessionId);
        const sourceRefs = typeof resolveEvidence === 'function'
          ? (decision?.verdict.evidenceRefs || []).filter(ref => Boolean(resolveEvidence(ref))) : [];
        if (decision?.verdict.outcome === 'passed' && decision.verdict.checks.every((check) => check.passed)
          && sourceRefs.length) {
          const written = lifecycle.recordVerifiedFindings(workspaceId, [{ text: message.content, sourceRefs }]);
          if (written.ok) {
            const profile = profileStore.read(workspaceId);
            profileStore.save({ ...profile, familiarize: { ...profile.familiarize, memoryRecorded: true } });
            replyMeta = { ...replyMeta, memoryLearned: [...(replyMeta?.memoryLearned || []), ...written.items.map(item => item.id)] };
            conversationStore.updateMessageById?.(message.conversationId || resolveConversationId(workspaceId), message.id, {
              meta: replyMeta,
            });
          }
        }
      }
      for (const sessionId of message.sources || []) {
        if (supervisor.get({ sessionId })?.workspaceId === workspaceId) await supervisor.settle(sessionId);
      }
      if (message.sources?.length) {
        const sessionStates = message.sources.flatMap(sessionId => {
          const session = supervisor.get({ sessionId });
          return session?.workspaceId === workspaceId ? [{ sessionId, status: session.status }] : [];
        });
        conversationStore.updateMessageById?.(message.conversationId || resolveConversationId(workspaceId), message.id, {
          meta: { ...replyMeta, sessionStates },
        });
      }
      broadcast?.('project-agent:conversation-changed', { workspaceIds: [workspaceId] });
    },
  };
}
