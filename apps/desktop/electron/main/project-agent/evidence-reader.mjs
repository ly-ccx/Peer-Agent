import { evidenceBodyFromRecord, evidenceBodyFromHistory, evidenceSourceDescription } from '@peer-agent/runtime-node';

/** Local, read-only retrieval. Source lists never read conversations or artifacts. */
export function createEvidenceReader({ findRecords, readMessages, readArtifact, readExternal = () => null }) {
  return (evidenceRef, { metadataOnly = false } = {}) => {
    let record;
    try {
      record = findRecords([evidenceRef])?.[0];
      if (!record) return metadataOnly ? null : readExternal(evidenceRef);
    } catch { return { availability: 'unavailable' }; }
    const source = evidenceSourceDescription(record);
    if (metadataOnly) return { source };
    try {
      const body = evidenceBodyFromRecord(record, ref => readArtifact(ref, record))
        ?? evidenceBodyFromHistory(record, readMessages);
      if (typeof body?.text === 'string') return { ...body, source, availability: 'available' };
      return { source, availability: record.artifactRefs?.length ? 'unavailable' : 'metadata_only' };
    } catch {
      return { source, availability: 'unavailable' };
    }
  };
}
