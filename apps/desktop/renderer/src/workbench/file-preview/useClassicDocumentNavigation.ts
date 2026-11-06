import { useMemo } from 'react';
import { useWorkbenchOptional } from '../WorkbenchContext';
import { documentReferenceLocation, documentReferencePath } from '../../chat/components/markdown/documentReference';
import { addBrowserTab, createBrowserTabSession } from '../browserSessionState';

/** Explicit human navigation under the unchanged classic read scope; no existence probing. */
export function useClassicDocumentNavigation(path: string, root: string | undefined, isZh: boolean, relativeBaseKnown = true) {
  const workbench = useWorkbenchOptional();
  return useMemo(() => workbench ? {
    label: isZh ? '打开文档' : 'Open document',
    resolve: (value: string) => {
      const target = documentReferencePath(value);
      return target && !target.startsWith('~/') && (relativeBaseKnown || /^(?:\/|[a-z]:[\\/])/i.test(target)) ? target : null;
    },
    open: (value: string) => {
      const location = documentReferenceLocation(value); if (!location || location.path.startsWith('~/')) return;
      if (!relativeBaseKnown && !/^(?:\/|[a-z]:[\\/])/i.test(location.path)) return;
      const target = /^(?:\/|[a-z]:[\\/])/i.test(location.path) ? location.path
        : `${path.replace(/[/\\][^/\\]*$/, '')}/${location.path}`;
      workbench.openFile(target, root, undefined, { ...(location.line ? { line: location.line } : {}) });
    },
    openUrl: (url: string) => {
      if (!/^https?:\/\//i.test(url)) return;
      workbench.setBrowserSession(session => addBrowserTab(session, createBrowserTabSession(undefined, url)));
      workbench.setActiveTab('browser'); workbench.setOpen(true);
    }, remoteImages: 'link' as const,
    remoteImageLabel: isZh ? '打开外部图片' : 'Open external image',
  } : null, [workbench, path, root, isZh, relativeBaseKnown]);
}
