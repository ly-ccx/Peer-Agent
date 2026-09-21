/** Private parent/child IPC for a Peer-owned preview. Never a renderer or model API. */
export const DESKTOP_PREVIEW_PROTOCOL = 'peer-desktop-preview-v1' as const;
export type DesktopPreviewScene = 'application' | 'background-runtime';
export type DesktopPreviewRequest = {
  protocol: typeof DESKTOP_PREVIEW_PROTOCOL;
  requestId: string;
  action: 'observe' | 'close' | 'keepalive';
  scene?: DesktopPreviewScene;
};
export type DesktopPreviewReply = {
  protocol: typeof DESKTOP_PREVIEW_PROTOCOL;
  requestId?: string;
  instanceId: string;
  status: 'ready' | 'observed' | 'failed';
  buildFingerprint?: string;
  scene?: DesktopPreviewScene;
  pngBase64?: string;
  width?: number;
  height?: number;
  error?: string;
};
export const DESKTOP_PREVIEW_CAPABILITY = 'local.desktop.preview' as const;
export const DESKTOP_PREVIEW_TOOL = 'desktop_preview' as const;
