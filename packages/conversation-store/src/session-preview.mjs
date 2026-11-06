/** Materialized list preview (ADR 121). Derived display, not Evidence or a message body. */
export const SESSION_PREVIEW_LIMIT = 80;

const VISIBLE_KINDS = new Set(['user_input', 'agent_reply', 'system_card', 'agent_activity']);

export function truncatePreview(value, limit = SESSION_PREVIEW_LIMIT) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const cap = Number.isInteger(limit) && limit >= 0 ? limit : 0;
  return Array.from(text).slice(0, cap).join('');
}

function messageKind(message) {
  const kind = message?.kind || message?.type || message?.messageKind;
  return typeof kind === 'string' ? kind : '';
}

export function isPreviewMessage(message) {
  const kind = messageKind(message);
  if (kind === 'agent_activity' && ['verifying', 'verified'].includes(message?.agentActivity?.state)) return false;
  if (kind === 'system_card' && Array.isArray(message?.cards) && message.cards.length
    && message.cards.every((card) => card?.kind === 'verdict')) return false;
  if (VISIBLE_KINDS.has(kind)) return true;
  if (!kind && (message?.role === 'user' || message?.role === 'assistant')) return true;
  return false;
}

function messageText(message) {
  const text = typeof message?.content === 'string' ? message.content
    : typeof message?.text === 'string' ? message.text : '';
  if (text.trim()) return text;
  return (Array.isArray(message?.attachments) ? message.attachments : [])
    .map((item) => (typeof item?.name === 'string' ? item.name : ''))
    .filter(Boolean)
    .join(', ');
}

function compactQuestion(question) {
  if (!question || typeof question !== 'object' || Array.isArray(question)) return undefined;
  const prompt = typeof question.prompt === 'string' ? question.prompt.slice(0, 2000) : undefined;
  const options = Array.isArray(question.options)
    ? question.options.slice(0, 12).map((item) => truncatePreview(item, 200)).filter(Boolean)
    : undefined;
  const compact = {
    ...(prompt !== undefined ? { prompt } : {}),
    ...(options?.length ? { options } : {}),
    ...(question.answered === true ? { answered: true } : {}),
    ...(question.answered === false ? { answered: false } : {}),
    ...(typeof question.expiresAt === 'string' ? { expiresAt: question.expiresAt } : {}),
  };
  return Object.keys(compact).length ? compact : undefined;
}

/** Facts for one visible message. Internal turns and empty bubbles return null. */
export function previewFactsFromMessage(message) {
  if (!isPreviewMessage(message)) return null;
  const attachmentNames = (Array.isArray(message?.attachments) ? message.attachments : [])
    .map((item) => (typeof item?.name === 'string' ? item.name : ''))
    .filter(Boolean)
    .slice(0, 8);
  const excerpt = truncatePreview(messageText(message));
  if (!excerpt && attachmentNames.length === 0) return null;
  const kind = messageKind(message);
  const role = kind === 'user_input' || message?.role === 'user' ? 'user' : 'assistant';
  const surfacing = message?.kind === 'agent_activity' ? 'silent' : message?.meta?.surfacing || message?.surfacing;
  const at = typeof message?.createdAt === 'string' && message.createdAt
    ? message.createdAt
    : (typeof message?.at === 'string' ? message.at : '');
  const question = compactQuestion(message?.question);
  return {
    excerpt: excerpt || truncatePreview(attachmentNames.join(', ')),
    ...(typeof message?.id === 'string' && message.id ? { messageId: message.id } : {}),
    role,
    kind: kind || (role === 'user' ? 'user_input' : 'agent_reply'),
    ...(at ? { at } : {}),
    ...(question ? { question } : {}),
    ...(attachmentNames.length ? { attachmentNames } : {}),
    ...(surfacing === 'silent' || message?.meta?.unread === false ? { countUnread: false } : {}),
    ...(typeof surfacing === 'string' && surfacing ? { surfacing } : {}),
  };
}

export function previewFactsFromMessages(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const facts = previewFactsFromMessage(messages[index]);
    if (facts) return facts;
  }
  return null;
}

export function sessionPreviewRecord(meta, facts) {
  const contentRevision = Number.isSafeInteger(Number(meta?.contentRevision)) ? Number(meta.contentRevision) : 0;
  const record = {
    conversationId: typeof meta?.id === 'string' ? meta.id : '',
    title: truncatePreview(typeof meta?.title === 'string' ? meta.title : ''),
    excerpt: facts?.excerpt || '',
    updatedAt: typeof meta?.updatedAt === 'string' ? meta.updatedAt : '',
    contentRevision,
    availability: 'ready',
  };
  if (!facts) return record;
  return {
    ...record,
    ...(facts.messageId ? { messageId: facts.messageId } : {}),
    ...(facts.role ? { role: facts.role } : {}),
    ...(facts.kind ? { kind: facts.kind } : {}),
    ...(facts.at ? { at: facts.at } : {}),
    ...(facts.question ? { question: facts.question } : {}),
    ...(facts.attachmentNames ? { attachmentNames: facts.attachmentNames } : {}),
    ...(facts.countUnread === false ? { countUnread: false } : {}),
    ...(facts.surfacing ? { surfacing: facts.surfacing } : {}),
  };
}

/**
 * Ready only when the stored preview was written for this contentRevision.
 * A miss is rebuilding: callers must not treat a stale excerpt as current.
 */
export function coerceSessionPreview(meta) {
  const contentRevision = Number.isSafeInteger(Number(meta?.contentRevision)) ? Number(meta.contentRevision) : 0;
  const title = truncatePreview(typeof meta?.title === 'string' ? meta.title : '');
  const updatedAt = typeof meta?.updatedAt === 'string' ? meta.updatedAt : '';
  const rebuilding = {
    conversationId: typeof meta?.id === 'string' ? meta.id : '',
    title,
    excerpt: '',
    updatedAt,
    contentRevision,
    availability: 'rebuilding',
  };
  const stored = meta?.preview;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return rebuilding;
  if (stored.availability === 'damaged') return { ...rebuilding, availability: 'damaged' };
  const storedRevision = Number(stored.contentRevision);
  if (!Number.isSafeInteger(storedRevision) || storedRevision !== contentRevision) return rebuilding;
  if (typeof stored.excerpt !== 'string') return rebuilding;
  return {
    conversationId: rebuilding.conversationId,
    title: typeof stored.title === 'string' ? truncatePreview(stored.title) : title,
    excerpt: truncatePreview(stored.excerpt),
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : updatedAt,
    contentRevision,
    availability: 'ready',
    ...(typeof stored.messageId === 'string' && stored.messageId ? { messageId: stored.messageId } : {}),
    ...(stored.role === 'user' || stored.role === 'assistant' ? { role: stored.role } : {}),
    ...(typeof stored.kind === 'string' && stored.kind ? { kind: stored.kind } : {}),
    ...(typeof stored.at === 'string' && stored.at ? { at: stored.at } : {}),
    ...(stored.question && typeof stored.question === 'object' ? { question: stored.question } : {}),
    ...(Array.isArray(stored.attachmentNames) ? { attachmentNames: stored.attachmentNames.filter((name) => typeof name === 'string') } : {}),
    ...(stored.countUnread === false ? { countUnread: false } : {}),
    ...(typeof stored.surfacing === 'string' && stored.surfacing ? { surfacing: stored.surfacing } : {}),
  };
}

/** Keep the previous visible excerpt when a non-visible row is appended. */
export function assignSessionPreview(meta, source) {
  const facts = Array.isArray(source) ? previewFactsFromMessages(source) : previewFactsFromMessage(source);
  if (facts) {
    meta.preview = sessionPreviewRecord(meta, facts);
    return meta.preview;
  }
  if (!Array.isArray(source) && meta.preview && typeof meta.preview === 'object' && !Array.isArray(meta.preview)) {
    meta.preview = sessionPreviewRecord(meta, {
      excerpt: typeof meta.preview.excerpt === 'string' ? meta.preview.excerpt : '',
      messageId: meta.preview.messageId,
      role: meta.preview.role,
      kind: meta.preview.kind,
      at: meta.preview.at,
      question: meta.preview.question,
      attachmentNames: meta.preview.attachmentNames,
      countUnread: meta.preview.countUnread,
      surfacing: meta.preview.surfacing,
    });
    return meta.preview;
  }
  meta.preview = sessionPreviewRecord(meta, null);
  return meta.preview;
}
