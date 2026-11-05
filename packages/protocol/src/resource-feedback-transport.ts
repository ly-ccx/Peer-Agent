import type { ProjectInputAttachment } from './delegation.ts';
import { normalizeResourceFeedback, normalizeResourceFeedbackList, type ResourceFeedback } from './resource-feedback.ts';

export const INTERACTIVE_FEEDBACK_TRANSPORT = 'peer-interactive-selection-1';
const fail = (code: string): never => { throw Object.assign(new TypeError(code), { code }); };
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function isInteractiveFeedbackAttachment(raw: unknown): boolean {
  const item = raw as Partial<ProjectInputAttachment> | null;
  return !!item && (typeof item.id === 'string' && /^interactive-[a-f0-9]{64}$/.test(item.id)
    || item.kind === 'text' && typeof item.text === 'string' && /^\s*\{\s*"schema"\s*:\s*"peer-interactive-selection-/.test(item.text));
}
export function interactiveFeedbackAttachment(raw: unknown): ProjectInputAttachment {
  const row = normalizeResourceFeedback(raw);
  if (row?.resource.kind !== 'interactive' || row.version.kind !== 'interactive') return fail('INVALID_INTERACTIVE_FEEDBACK');
  const body = JSON.stringify({ schema: INTERACTIVE_FEEDBACK_TRANSPORT, feedback: row });
  if (bytes(body) > 33 * 1024) return fail('INTERACTIVE_FEEDBACK_LIMIT');
  return { id: `interactive-${row.version.selectionDigest.slice(7)}`, name: 'Interactive conditions.json', mimeType: 'application/json', size: bytes(body),
    sourceKind: 'user_upload', kind: 'text', text: body };
}
export function readInteractiveFeedbackAttachment(raw: unknown): ResourceFeedback | undefined {
  if (!isInteractiveFeedbackAttachment(raw)) return;
  const item = raw as ProjectInputAttachment;
  if (item?.sourceKind !== 'user_upload' || item.kind !== 'text' || typeof item.text !== 'string' || bytes(item.text) > 33 * 1024) return fail('INVALID_INTERACTIVE_FEEDBACK_TRANSPORT');
  let parsed;
  try { parsed = JSON.parse(item.text); } catch { return fail('INVALID_INTERACTIVE_FEEDBACK_TRANSPORT'); }
  if (!parsed || Object.keys(parsed).length !== 2 || parsed.schema !== INTERACTIVE_FEEDBACK_TRANSPORT || !('feedback' in parsed)) return fail('INTERACTIVE_FEEDBACK_TRANSPORT_INCOMPATIBLE');
  const row = normalizeResourceFeedback(parsed.feedback);
  if (!row || row.resource.kind !== 'interactive' || row.version.kind !== 'interactive') return fail('INVALID_INTERACTIVE_FEEDBACK_TRANSPORT');
  const expected = interactiveFeedbackAttachment(row);
  if (Object.keys(item).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => (item as unknown as Record<string, unknown>)[key] !== value)) return fail('INTERACTIVE_FEEDBACK_TRANSPORT_CONFLICT');
  return row;
}

/** Logical typed material; callers still validate the actual immutable host receipt. */
export function restoreResourceFeedbackTransport(rawRows: unknown, rawAttachments: readonly unknown[] = []) {
  const rows = normalizeResourceFeedbackList(rawRows); if (!rows) return fail('INVALID_RESOURCE_FEEDBACK');
  const selected = new Map(rows.map(row => [row.id, row]));
  for (const item of rawAttachments) {
    const row = readInteractiveFeedbackAttachment(item); if (!row) continue;
    const previous = selected.get(row.id);
    if (previous && !equal(previous, row)) return fail('RESOURCE_FEEDBACK_ID_CONFLICT');
    selected.set(row.id, row);
  }
  const restored = normalizeResourceFeedbackList([...selected.values()]);
  if (!restored) return fail('RESOURCE_FEEDBACK_LIMIT');
  return restored;
}
/** Only known legacy fields enter shared queues/messages. No path, permission, or new input lane. */
export function encodeResourceFeedbackTransport(rawRows: unknown, rawAttachments: readonly ProjectInputAttachment[] = []) {
  const rows = restoreResourceFeedbackTransport(rawRows, rawAttachments);
  const attachments = [...rawAttachments], legacy = rows.filter(row => row.resource.kind !== 'interactive');
  for (const row of rows.filter(row => row.resource.kind === 'interactive')) {
    const attachment = interactiveFeedbackAttachment(row), previous = attachments.find(item => item.id === attachment.id);
    // Legacy upload normalizers may reconstruct the same fields in a different
    // property order. The strict decoder already checked every field and byte.
    if (previous && !equal(readInteractiveFeedbackAttachment(previous), row)) return fail('RESOURCE_FEEDBACK_ID_CONFLICT');
    if (!previous) attachments.push(attachment);
  }
  if (attachments.length > 8) return fail('RESOURCE_FEEDBACK_ATTACHMENT_LIMIT');
  return { ...(legacy.length ? { resourceFeedback: legacy } : {}), ...(attachments.length ? { attachments } : {}) };
}

/** Read-only user-context projection. Syntax is not proof of a host receipt or authority.
 * Invalid carriers remain ordinary attachments so their original text is still recoverable.
 */
export function projectResourceFeedbackTransport(rawRows: unknown, rawAttachments: unknown) {
  const attachments: readonly unknown[] = Array.isArray(rawAttachments) ? rawAttachments : [];
  try {
    return { resourceFeedback: restoreResourceFeedbackTransport(rawRows, attachments),
      attachments: attachments.filter(item => !isInteractiveFeedbackAttachment(item)), invalid: false };
  } catch {
    return { resourceFeedback: [], attachments, invalid: true };
  }
}
