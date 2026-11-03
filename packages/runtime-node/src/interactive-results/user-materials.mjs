import { INTERACTIVE_RESULT_LIMITS as L, interactiveToken } from '@peer-agent/protocol';
import { boundedJSON } from '@peer-agent/interactive-content/values';
import { normalizeUserUpload } from '../project-agent/input-attachments.mjs';
import { redactInteractiveJSONText } from './observation-redaction.mjs';
import { jsonDigest, problem } from './storage.mjs';

/** Canonical inline uploads only. No attachment paths, source file reads or Tool Result claims. */
export function createInteractiveUserMaterials({ conversationStore }) {
  const history = execution => conversationStore?.getPersistedConversationHistory?.(execution.source?.conversationId)?.messages ?? [];
  function observation(message, attachment, execution) {
    const upload = normalizeUserUpload(attachment);
    if (message.role !== 'user' || upload.kind !== 'text' || upload.sourceKind !== 'user_upload'
      || !interactiveToken(message.id) || !interactiveToken(upload.id) || !Number.isFinite(Date.parse(message.createdAt))
      || !['D0_public', 'D1_internal', 'D2_sensitive', 'D3_private', 'D4_regulated'].includes(execution.dataLevel)) throw problem('material_snapshot_unavailable');
    const decoded = redactInteractiveJSONText(upload.text, { maxBytes: L.inputBytes, maxItems: 10_000, maxStringChars: L.inputBytes });
    const value = { format: 'peer-user-upload-1', text: decoded.text, ...(decoded.parsed ? { json: decoded.json } : {}) };
    const normalized = boundedJSON(value, { maxBytes: L.inputBytes * 4, maxItems: 10_000, maxStringChars: L.inputBytes });
    const contentVersion = jsonDigest(normalized);
    return { canonical: true, available: true, contentVersion, value: normalized,
      source: { kind: 'user-material', messageId: message.id, attachmentId: upload.id, expectedContentVersion: contentVersion },
      observedAt: message.createdAt, dataLevel: execution.dataLevel, redacted: decoded.redacted, truncated: false, evidenceRefs: [] };
  }
  return {
    list(execution) {
      const items = [];
      for (const message of history(execution).slice(-64)) {
        if (message.role !== 'user') continue;
        for (const attachment of (message.attachments ?? []).slice(0, 8)) {
          try { const record = observation(message, attachment, execution);
            if (execution.admitMaterial(record.source) === true) items.push({ source: record.source,
              format: 'peer-user-upload-1', selectorRoots: Object.hasOwn(record.value, 'json') ? ['text', 'json'] : ['text'],
              dataLevel: record.dataLevel, truncated: record.truncated, redacted: record.redacted });
          } catch { /* Unsupported/unclassified/missing canonical material is never advertised. */ }
          if (items.length >= L.bindings) return items;
        }
      }
      return items;
    },
    read(source, execution) {
      const message = history(execution).find(message => message.role === 'user' && message.id === source.messageId);
      const attachment = message?.attachments?.find(attachment => attachment.id === source.attachmentId);
      if (!message || !attachment) return null;
      const record = observation(message, attachment, execution);
      if (record.contentVersion !== source.expectedContentVersion) throw problem('material_version_mismatch');
      return record;
    },
  };
}
