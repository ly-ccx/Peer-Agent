/** ADR 90: local images are factual context, never instructions or persisted pixels. */
export const LOCAL_IMAGE_CAPABILITY = 'local.image.read' as const;
export const LOCAL_IMAGE_TOOL = 'view_image' as const;
export const LOCAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const LOCAL_IMAGE_MAX_PIXELS = 24_000_000;
export type LocalImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export interface LocalImageMetadata {
  path: string;
  mediaType: LocalImageMediaType;
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
  artifactRef: string;
}
/** Ephemeral host sideband. Object identity must also be validated by its Provider. */
export interface LocalImageObservation extends LocalImageMetadata {
  kind: 'local_image';
  dataUrl: string;
}
import type { ClientToolResult, PermissionGrant } from './index.ts';
export interface LocalImagePermissionScope {
  capabilityId: typeof LOCAL_IMAGE_CAPABILITY;
  path: string;
  workspacePath: string | null;
  action: 'read_image_for_model';
}
/** Concrete image grant; legacy grant scopes remain unchanged. */
export interface LocalImagePermissionGrant extends PermissionGrant {
  scope: LocalImagePermissionScope | typeof LOCAL_IMAGE_CAPABILITY;
}
export interface LocalImageToolResult extends ClientToolResult {
  modelContext?: { visualObservations: readonly LocalImageObservation[] };
}
