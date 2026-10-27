import { evidenceBodyFromRecord, evidenceBodyFromHistory, evidenceSourceDescription } from '@peer-agent/runtime-node';

/** Local, read-only retrieval. Source lists never read conversations or artifacts. */
export function createEvidenceReader({ findRecords, readMessages, readArtifact, readExternal = () => null, readScopedExternal, projectDeliveries }) {
  return (evidenceRef, { metadataOnly = false, context } = {}) => {
    let record;
    try {
      record = findRecords([evidenceRef])?.[0];
      if (!record) return context !== undefined ? readScopedExternal?.(evidenceRef, context, { metadataOnly })
        ?? { availability: 'not_found', deliveryStatus: 'unavailable' } : metadataOnly ? null : readExternal(evidenceRef);
    } catch { return { availability: 'unavailable' }; }
    let delivery = {};
    if (context !== undefined) {
      try { delivery = projectDeliveries?.(record, context) ?? { deliveryStatus: 'unavailable' }; }
      catch { return { availability: 'unavailable', deliveryStatus: 'unavailable' }; }
      if (delivery.deliveryStatus !== 'available') return { availability: 'unavailable', ...delivery, code: delivery.deliveryStatus === 'scope_denied' ? 'SCOPE_DENIED' : 'READ_FAILED' };
    }
    const source = evidenceSourceDescription(record);
    if (metadataOnly) return { source };
    try {
      const body = evidenceBodyFromRecord(record, ref => readArtifact(ref, record))
        ?? evidenceBodyFromHistory(record, readMessages);
      if (typeof body?.text === 'string') return { ...body, ...delivery, source, availability: 'available' };
      return { source, ...delivery, availability: record.artifactRefs?.length ? 'unavailable' : 'metadata_only' };
    } catch {
      return { source, ...delivery, availability: 'unavailable' };
    }
  };
}
