import { createContext } from 'react';

/** Optional human preview adapter. Does not resolve paths or access the filesystem. */
export const DocumentPreviewContext = createContext<{
  readonly open: (path: string, trigger: HTMLElement) => void;
  readonly label: string;
} | null>(null);
