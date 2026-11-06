import { isCanonicalUserInput } from './user-priority.mjs';

/** Identity only. The caller owns the conversation slice and action admission. */
export function resolveUserAnchors(ids, messages, field) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) return {
    ok: false, error: 'invalid_input', message: `${field} must be a list of message IDs.`,
  };
  const rows = Array.isArray(messages) ? messages.filter(row => row && typeof row === 'object') : [];
  const resolved = [];
  /** @type {import('@peer-agent/protocol').UserAnchorResolution[]} */
  const anchorResolutions = [];
  for (const suppliedId of ids) {
    let matches = rows.filter(row => messageId(row) === suppliedId);
    let source = 'message_id';
    if (!matches.length) {
      source = 'input_id';
      matches = rows.filter(row => row.inputId === suppliedId && isCanonicalUserInput(row));
    }
    if (matches.length !== 1) return { ok: false, error: matches.length ? 'anchor_ambiguous' : 'anchor_not_found',
      messageIds: [suppliedId], message: matches.length ? 'Anchor identity is ambiguous in this conversation.' : 'Anchor message was not found in this conversation.' };
    const id = messageId(matches[0]);
    if (typeof id !== 'string' || !id) return { ok: false, error: 'anchor_not_found', messageIds: [suppliedId] };
    resolved.push(id);
    anchorResolutions.push({ field, suppliedId, messageId: id, source });
  }
  return { ok: true, ids: [...new Set(resolved)], anchorResolutions };
}

/** Bounded factual diagnostics: no attachments or inferred authorization. */
export function userAnchorCandidates(messages, predicate, allowedIds) {
  return (Array.isArray(messages) ? messages : []).filter(row => row && typeof row === 'object' && typeof messageId(row) === 'string' && predicate(row)
    && (!allowedIds || allowedIds.includes(messageId(row)))).slice(-5).map(row => ({
    messageId: messageId(row), text: typeof row.content === 'string' ? row.content.slice(0, 120) : '',
  }));
}

/** Resolve only the three reviewed model fields, never sources/Evidence/versions. */
export function resolveDelegationAnchors(name, input, messages) {
  input = input && typeof input === 'object' ? input : {};
  const field = name === 'spawn_session' ? 'anchorMessageIds' : name === 'post_reply' ? 'replyTo'
    : name === 'coordinate_work' && input.task ? 'task.anchorMessageIds' : null;
  if (!field) return { ok: true, input, anchorResolutions: [] };
  const resolution = resolveUserAnchors(field === 'task.anchorMessageIds' ? input.task.anchorMessageIds : input[field] || [], messages, field);
  if (!resolution.ok) return resolution;
  return { ...resolution, input: field === 'task.anchorMessageIds'
    ? { ...input, task: { ...input.task, anchorMessageIds: resolution.ids } } : { ...input, [field]: resolution.ids } };
}

const messageId = row => row?.id || row?.messageId;
