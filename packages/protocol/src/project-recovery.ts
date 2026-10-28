/** Local maintenance controls. These commands never accept an execution verdict or a filesystem path. */
export interface ProjectRecoveryRequest {
  readonly workspaceId: string;
  readonly action: 'inspect' | 'restore' | 'retain';
  readonly planToken?: string;
  readonly workId?: string;
  readonly sessionId?: string;
}
export interface ProjectRecoveryWork {
  readonly workId: string;
  readonly title: string;
  readonly disposition: 'held' | 'resume';
  readonly reason: string;
}
export interface ProjectRecoveryView {
  readonly phase: 'occupied' | 'inspection' | 'stopping' | 'backing_up' | 'restoring' | 'reconciling' | 'ready' | 'failed';
  readonly planToken?: string;
  readonly restored: boolean;
  readonly canContinue: boolean;
  readonly runtimeReady: boolean;
  readonly completedCount: number;
  readonly works: readonly ProjectRecoveryWork[];
  readonly sessions: readonly { readonly sessionId: string; readonly title: string }[];
  readonly holder?: { readonly surface: 'desktop' | 'tui'; readonly version: string };
  readonly backupAvailable: boolean;
  readonly backupLocation?: string;
  readonly code?: string;
}
export type ProjectRecoveryResult = { readonly ok: true; readonly view: ProjectRecoveryView }
  | { readonly ok: false; readonly code: string; readonly view?: ProjectRecoveryView };
