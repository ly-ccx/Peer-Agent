import type { BotDocumentReference } from './document-reference.ts';
import type { InteractiveResultReference } from './interactive-result.ts';

/** Read-only display facts. A saved operation is not proof that its task completed. */
export interface EvidenceSourceDescription {
  readonly evidenceRef: string;
  readonly toolName?: string;
  readonly createdAt?: string;
}

export interface ProjectAgentEvidenceReadRequest {
  readonly context?: { readonly workspaceId: string; readonly task?: BotDocumentReference['task'] };
  readonly evidenceRef?: string;
  /** Source descriptions only; at most 100 unique references, no body or artifact reads. */
  readonly evidenceRefs?: readonly string[];
}

export interface ProjectAgentEvidenceReadResult {
  readonly deliveryStatus?: 'available' | 'scope_denied' | 'unavailable';
  readonly deliveries?: readonly EvidenceDelivery[];
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

/** Navigation provenance only; revalidated against the canonical index after restore. */
export interface EvidenceDeliveryBinding {
  readonly evidenceRef: string;
  readonly artifactRef: string;
}
export interface EvidenceFileDelivery extends EvidenceDeliveryBinding {
  readonly kind: 'file' | 'code-change' | 'image';
  readonly label: string;
  /** A locator, never a grant or proof of historical bytes. Read through the existing scoped service. */
  readonly reference?: BotDocumentReference;
  readonly savedPreview?: { readonly kind: 'diff-summary'; readonly text: string; readonly truncated: true }
    | { readonly kind: 'image'; readonly dataUrl: string; readonly width: number; readonly height: number };
  readonly previewUnavailable?: boolean;
}
/** A published domain reference. Never a filesystem locator or execution/verification receipt. */
export interface EvidenceInteractiveDelivery extends EvidenceDeliveryBinding {
  readonly kind: 'interactive';
  readonly label: string;
  readonly interactiveReference: InteractiveResultReference;
  readonly specHash: string;
  readonly reference?: never;
  readonly savedPreview?: never;
  readonly previewUnavailable?: never;
}
export type EvidenceDelivery = EvidenceFileDelivery | EvidenceInteractiveDelivery;
