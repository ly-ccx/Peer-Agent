import { evidenceBodyFromRecord, evidenceBodyFromHistory, evidenceSourceDescription } from '@peer-agent/runtime-node';

/** Local, read-only retrieval. Source lists never read conversations or artifacts. */
export function createEvidenceReader({ findRecords, readMessages, readArtifact, readExternal = () => null, readScopedExternal, projectDeliveries, resolveScopedRecord }) {
  return (evidenceRef, { metadataOnly = false, context } = {}) => {
    let record, resolved;
    if (context !== undefined && !metadataOnly && resolveScopedRecord) {
      try { resolved = resolveScopedRecord(evidenceRef, context); }
      catch (error) { return { availability: 'unavailable', deliveryStatus: error?.code === 'interactive_scope_denied' ? 'scope_denied' : 'unavailable',
        code: error?.code === 'interactive_scope_denied' ? 'SCOPE_DENIED' : 'READ_FAILED' }; }
    }
    try {
      record = resolved?.record ?? findRecords([evidenceRef])?.[0];
      if (!record) return context !== undefined ? readScopedExternal?.(evidenceRef, context, { metadataOnly })
        ?? { availability: 'not_found', deliveryStatus: 'unavailable' } : metadataOnly ? null : readExternal(evidenceRef);
    } catch { return { availability: 'unavailable' }; }
    let delivery = {};
    if (context !== undefined) {
      try { delivery = projectDeliveries?.(record, resolved?.context ?? context) ?? { deliveryStatus: 'unavailable' }; }
      catch { return { availability: 'unavailable', deliveryStatus: 'unavailable' }; }
      if (delivery.deliveryStatus !== 'available') return { availability: 'unavailable', ...delivery, code: delivery.deliveryStatus === 'scope_denied' ? 'SCOPE_DENIED' : 'READ_FAILED' };
    }
    const source = evidenceSourceDescription(record);
    if (metadataOnly) return { source };
    try {
      const body = resolved?.body ?? evidenceBodyFromRecord(record, ref => readArtifact(ref, record))
        ?? evidenceBodyFromHistory(record, readMessages);
      if (typeof body?.text === 'string') return { ...body, ...delivery, source, availability: 'available' };
      return { source, ...delivery, availability: record.artifactRefs?.length ? 'unavailable' : 'metadata_only' };
    } catch {
      return { source, ...delivery, availability: 'unavailable' };
    }
  };
}
