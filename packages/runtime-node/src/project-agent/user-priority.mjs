import { inputMessageId } from './input-queue.mjs';

/** High priority needs the current turn's direct urgency request in canonical user history. */
export function hasCurrentUserUrgency({ conversationStore, parentConversationId, currentInputAnchors, anchorMessageIds } = {}) {
  const current = new Set(Array.isArray(currentInputAnchors) ? currentInputAnchors : []);
  const requested = new Set((Array.isArray(anchorMessageIds) ? anchorMessageIds : []).filter(id => current.has(id)));
  if (!requested.size) return false;
  const history = conversationStore?.getPersistedConversationHistory?.(parentConversationId);
  return history?.messages?.some(message => requested.has(message.id) && isCanonicalUserInput(message) && directUrgency(message.content)) === true;
}

function directUrgency(content) {
  if (typeof content !== 'string') return false;
  const text = content.replace(/```[\s\S]*?```|`[^`]*`|^[ \t]*>.*$|“[^”]*”|「[^」]*」|"[^"\n]*"/gm, '');
  if (/(?:不(?:着)?急|不紧急|(?:不(?:用|必|需要)?|无需|不要|别).{0,8}(?:加急|紧急|优先)|不.{0,4}高优先级|(?:not|isn['’]?t)\s+(?:urgent|high\s+priority)|no\s+rush|(?:don['’]?t|do\s+not)\s+(?:prioriti[sz]e|expedite))/i.test(text)) return false;
  return /(?:紧急|加急|优先处理|高优先级|\burgent\b|\bexpedite\b|\bprioriti[sz]e\b|\bhigh\s+priority\b)/i.test(text);
}


export function isCanonicalUserInput(message) {
  if (message?.role !== 'user') return false;
  if (message.kind === 'user_input') return true;
  if (message.kind != null || typeof message.inputId !== 'string') return false;
  try { return message.id === inputMessageId(message.inputId); } catch { return false; }
}
