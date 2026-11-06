import type { BrowserWindowAction, BrowserWindowIdentity, BrowserWindowResult, BrowserWindowState } from '@peer-agent/protocol';
export interface BrowserWindowApi {
  readonly initialAppearance: Record<string, unknown>;
  readonly initialLocale: string;
  readonly onAppearanceChanged: (listener: (appearance: unknown) => void) => () => void;
  readonly bootstrap: () => Promise<BrowserWindowResult>;
  readonly action: (request: { readonly identity: BrowserWindowIdentity; readonly action: BrowserWindowAction; readonly url?: string }) => Promise<BrowserWindowResult>;
  readonly viewport: (request: { readonly identity: BrowserWindowIdentity; readonly rect: { x: number; y: number; width: number; height: number } }) => Promise<BrowserWindowResult>;
  readonly onFeedbackNotice?: (listener: (notice: import('@peer-agent/protocol').BrowserResourceFeedbackNotice) => void) => () => void;
  readonly onState: (listener: (state: BrowserWindowState) => void) => () => void;
}
