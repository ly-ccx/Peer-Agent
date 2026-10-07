/** Read-only display facts. A saved operation is not proof that its task completed. */
export interface EvidenceSourceDescription {
  readonly evidenceRef: string;
  readonly toolName?: string;
  readonly createdAt?: string;
}

export interface ProjectAgentEvidenceReadRequest {
  readonly evidenceRef?: string;
  /** Source descriptions only; at most 100 unique references, no body or artifact reads. */
  readonly evidenceRefs?: readonly string[];
}

export interface ProjectAgentEvidenceReadResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly evidenceRef?: string;
  readonly kind?: 'file' | 'command' | 'diff' | 'screenshot' | 'observation';
  readonly summary?: string;
  readonly truncated?: boolean;
  readonly availability?: 'available' | 'metadata_only' | 'not_found' | 'unavailable';
  readonly source?: EvidenceSourceDescription;
  readonly items?: readonly EvidenceSourceDescription[];
}
