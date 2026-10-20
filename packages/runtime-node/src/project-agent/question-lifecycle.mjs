/** Conversational decisions are scoped to the latest formal reply. Never authorizes an action. */
export function projectReplyQuestions(messages = [], now = Date.now()) {
  const states = new Map();
  let current = null;
  const close = (state) => {
    if (current && states.get(current.id)?.state === 'open') states.set(current.id, { state });
  };
  for (const message of messages) {
    const user = message?.kind === 'user_input' || (!message?.kind && message?.role === 'user');
    const reply = message?.kind === 'agent_reply' || (!message?.kind && message?.role === 'assistant');
    if (user) {
      if (current && (message.answerTo === `card:question:reply:${current.id}`
        || !message.answerTo && (!message.quoteRefs?.length || message.quoteRefs.includes(current.id)))) close('answered');
      continue;
    }
    if (!reply) continue;
    close('superseded');
    current = null;
    if (!message.id || !message.question || typeof message.question !== 'object') continue;
    const deadline = Date.parse(message.question.expiresAt);
    const expired = Number.isFinite(deadline) && deadline <= Number(now);
    const state = message.question.answered === true ? 'answered' : expired ? 'expired' : 'open';
    states.set(message.id, { state });
    current = message;
  }
  return states;
}
