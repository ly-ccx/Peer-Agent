/** High priority needs the current turn's direct urgency request in canonical user history. */
export function hasCurrentUserUrgency({ conversationStore, parentConversationId, currentInputAnchors, anchorMessageIds } = {}) {
  const current = new Set(Array.isArray(currentInputAnchors) ? currentInputAnchors : []);
  const requested = new Set((Array.isArray(anchorMessageIds) ? anchorMessageIds : []).filter(id => current.has(id)));
  if (!requested.size) return false;
  const history = conversationStore?.getPersistedConversationHistory?.(parentConversationId);
  return history?.messages?.some(message => requested.has(message.id) && message.role === 'user'
    && message.kind === 'user_input' && directUrgency(message.content)) === true;
}

function directUrgency(content) {
  if (typeof content !== 'string') return false;
  const text = content.replace(/```[\s\S]*?```|`[^`]*`|^[ \t]*>.*$|“[^”]*”|「[^」]*」|"[^"\n]*"/gm, '');
  if (/(?:不(?:着)?急|不紧急|无需加急|不用.{0,12}(?:加急|优先)|不要.{0,12}(?:加急|优先)|不.{0,4}高优先级|not\s+urgent|no\s+rush|(?:don['’]?t|do\s+not)\s+(?:prioriti[sz]e|expedite))/i.test(text)) return false;
  return /(?:紧急|加急|优先处理|高优先级|\burgent\b|\bexpedite\b|\bprioriti[sz]e\b|\bhigh\s+priority\b)/i.test(text);
}
