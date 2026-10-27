import type { ResourceWindowIdentity, ResourceWindowNavigation, ResourceWindowReadRequest, ResourceWindowReadResult, ResourceWindowResult } from '@peer-agent/protocol';
/** Dedicated native surface. Intentionally does not extend the main-window API. */
export interface ResourceWindowApi {
  readonly resourceEdits?: import('@peer-agent/protocol').ResourceEditsApi;
  readonly initialAppearance: unknown;
  readonly initialLocale: string;
  readonly onAppearanceChanged: (listener: (appearance: unknown) => void) => () => void;
  readonly prepareFeedback?: (request: { readonly identity: ResourceWindowIdentity; readonly feedback: import('@peer-agent/protocol').ResourceFeedback }) => Promise<import('@peer-agent/protocol').ResourceFeedbackPreparationResult>;
  readonly bootstrap: () => Promise<ResourceWindowResult>;
  readonly ready: (identity: ResourceWindowIdentity) => Promise<ResourceWindowResult>;
  readonly read: (request: ResourceWindowReadRequest) => Promise<ResourceWindowReadResult>;
  readonly navigation: (request: { readonly identity: ResourceWindowIdentity; readonly navigation: ResourceWindowNavigation; readonly sequence: number }) => Promise<ResourceWindowResult>;
  readonly onCheckpointRequest: (listener: (request: import('@peer-agent/protocol').ResourceWindowCheckpointRequest) => void) => () => void;
  readonly acknowledgeCheckpoint: (request: import('@peer-agent/protocol').ResourceWindowCheckpointAck) => Promise<{ readonly ok: boolean }>;
  readonly onCloseBlocked: (listener: (notice: import('@peer-agent/protocol').ResourceWindowCloseBlocked) => void) => () => void;
  readonly returnToSource: (identity: ResourceWindowIdentity) => Promise<ResourceWindowResult>;
  readonly close: (identity: ResourceWindowIdentity) => Promise<ResourceWindowResult>;
}
