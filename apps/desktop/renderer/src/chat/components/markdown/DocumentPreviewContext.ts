import { createContext } from 'react';

/** Optional human preview adapter. Does not resolve paths or access the filesystem. */
export const DocumentPreviewContext = createContext<{
  readonly open: (path: string, trigger: HTMLElement) => void;
  readonly label: string;
  /** Resolve display text using exact source metadata; null leaves it as ordinary text. */
  readonly resolve?: (path: string) => string | null;
  readonly locate?: (path: string, candidates?: readonly string[]) => void;
  readonly locateLabel?: string;
  readonly openUrl?: (url: string) => void;
  /** Static local documents expose remote images as explicit navigation, never eager requests. */
  readonly remoteImages?: 'link';
  readonly remoteImageLabel?: string;
} | null>(null);
