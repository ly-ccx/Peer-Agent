import { INTERACTIVE_RESULT_LIMITS as L, interactiveDigest, interactiveToken } from '@peer-agent/protocol';
import { boundedJSON } from '@peer-agent/interactive-content/values';
import { redactInteractiveJSON, redactInteractiveJSONText } from './observation-redaction.mjs';
import { problem } from './storage.mjs';

const levels = ['D0_public', 'D1_internal', 'D2_sensitive', 'D3_private', 'D4_regulated'];

/** The exact returned observation, not EvidenceIndex bodyPreview or a re-read file. */
export function canonicalInteractiveObservation(execution, { observedAt } = {}) {
  const call = execution?.call, result = execution?.result;
  const grant = execution?.grant ?? result?.permissionGrant;
  const granted = grant?.granted === true || grant?.decision === 'allow';
  // Runtime Core associates its capability grant through the enclosing Tool Result;
  // Desktop's adapted grant carries the toolCallId directly. Preserve both contracts.
  const boundGrant = grant?.toolCallId === call?.toolCallId || grant?.toolCallId === undefined
    && grant?.decision === 'allow' && grant?.capabilityId === call?.capabilityId;
  if (!interactiveToken(call?.toolCallId) || result?.toolCallId !== call.toolCallId || !['success', 'completed'].includes(result.status)
    || !granted || !boundGrant || !interactiveToken(result.evidence?.evidenceId)
    || !Number.isFinite(Date.parse(result.completedAt ?? observedAt))) throw problem('material_snapshot_unavailable');
  if (!levels.includes(result.evidence.dataLevel)) throw problem('material_classification_unavailable');
  let payload;
  const sideband = Object.getOwnPropertyDescriptor(result, 'materialObservation');
  if (sideband && sideband.enumerable === false && 'value' in sideband) {
    const observation = sideband.value;
    if (observation?.schemaVersion !== 1 || observation.toolCallId !== call.toolCallId || observation.capabilityId !== call.capabilityId
      || observation.evidenceId !== result.evidence.evidenceId) throw problem('material_snapshot_unavailable');
    payload = observation.payload;
  } else if (result.output !== undefined) payload = result.output;
  else if (result.outputPreview?.fileResult?.success === true && typeof result.outputPreview.fileResult.output === 'string') {
    try { payload = JSON.parse(result.outputPreview.fileResult.output); } catch { throw problem('material_snapshot_unavailable'); }
  } else payload = result.outputPreview;
  // This is the existing JSON Tool Result boundary. Functions, accessors and
  // prototype-bearing values cannot become a canonical source.
  payload = boundedJSON(payload, { maxBytes: L.inputBytes * 8, maxItems: 10_000, maxStringChars: L.inputBytes * 8 });
  const sanitized = redactInteractiveJSON(payload, { observeTruncation: true });
  let redacted = result.evidence.redactions?.length > 0 || sanitized.redacted, truncated = sanitized.truncated;
  payload = sanitized.value;
  if (result.evidence.redactions?.some(value => /truncat/i.test(value))) truncated = true;
  const value = { format: 'peer-tool-observation-1', payload };
  // A deterministic JSON projection is explicitly tied to its returned text.
  // Keep the original returned text too; never fetch a path to fill a preview.
  for (const field of ['content', 'preview', 'stdout']) {
    const text = payload?.[field];
    if (typeof text !== 'string') continue;
    const decoded = redactInteractiveJSONText(text, { maxBytes: L.inputBytes * 8, maxItems: 10_000, maxStringChars: L.inputBytes * 8 });
    if (decoded.parsed) { payload[field] = decoded.text; value.json = decoded.json; value.jsonField = field; redacted ||= decoded.redacted; }
    break;
  }
  return { value: boundedJSON(value, { maxBytes: L.inputBytes * 8, maxItems: 10_000, maxStringChars: L.inputBytes * 8 }),
    dataLevel: result.evidence.dataLevel, observedAt: result.completedAt ?? observedAt, truncated, redacted,
    evidenceRefs: [`tool-result://${call.toolCallId}`, ...(result.evidence.artifactRefs ?? []).filter(ref => typeof ref === 'string').slice(0, 32)] };
}

export function createInteractiveCapture({ resultStore, resolveAuthority, now = () => new Date().toISOString() }) {
  return function captureExecution(execution, toolContext) {
    if (!execution?.call || execution.call.capabilityId?.startsWith('local.interactive.')) return execution;
    let authority;
    try { authority = resolveAuthority({ call: execution.call, toolContext }); }
    catch { return execution; } // Unadmitted or inactive rounds do not create material snapshots.
    if (authority.role !== 'session_worker') return execution;
    try {
      const observation = canonicalInteractiveObservation(execution, { observedAt: now() });
      const source = resultStore.recordMaterial({ ...observation, owner: authority.owner,
        source: { kind: 'tool-result', conversationId: authority.source.conversationId, toolCallId: execution.call.toolCallId } }, authority.assertCurrent);
      return { ...execution, interactiveMaterial: { source, format: 'peer-tool-observation-1', selectorRoots: Object.hasOwn(observation.value, 'json') ? ['payload', 'json'] : ['payload'],
        dataLevel: observation.dataLevel, truncated: observation.truncated, redacted: observation.redacted } };
    } catch (error) {
      return { ...execution, interactiveMaterialUnavailable: { code: error.code ?? 'material_snapshot_unavailable' } };
    }
  };
}

/** A host-produced factual notice; never promote a URI-looking string in tool text. */
export function appendInteractiveMaterialNotice(output, execution) {
  const notice = execution?.interactiveMaterial, source = notice?.source;
  if (!source || source.kind !== 'tool-result' || !interactiveToken(source.conversationId) || !interactiveToken(source.toolCallId)
    || source.toolCallId !== execution?.call?.toolCallId || !interactiveDigest(source.expectedContentVersion)
    || notice.format !== 'peer-tool-observation-1' || !levels.includes(notice.dataLevel)
    || !Array.isArray(notice.selectorRoots) || notice.selectorRoots.some(key => !['payload', 'json'].includes(key))
    || typeof notice.truncated !== 'boolean' || typeof notice.redacted !== 'boolean') return output;
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return JSON.stringify({ ...parsed, interactiveMaterial: notice });
  } catch {}
  return `${output}\nCanonical interactive material (fixed returned observation): ${JSON.stringify(notice)}`;
}
