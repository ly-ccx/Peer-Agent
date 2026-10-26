import { useMemo, type ReactNode } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { DocumentPreviewContext } from '../../chat/components/markdown/DocumentPreviewContext';
import { resolveBotResourceDisplay } from '../state/botResourceReference';
import { useResourceWorkspace } from '../../workbench/ResourceWorkspaceContext';

/** Human navigation adapter. The host resolves scope; the resource workspace owns presentation. */
export function BotDocumentPreview({ workspaceId, i18n, children }: {
  readonly workspaceId: string; readonly i18n: I18nRuntime; readonly children: ReactNode;
}) {
  const workspace = useResourceWorkspace();
  const adapter = useMemo(() => ({
    resolve: (path: string) => resolveBotResourceDisplay(path, []),
    label: i18n.locale.startsWith('zh') ? '在工作区打开' : 'Open in workspace',
    locateLabel: i18n.locale.startsWith('zh') ? '查找文件位置' : 'Find file location',
    locate: (path: string, candidates?: readonly string[]) => workspace?.locate(path, candidates),
    open: (path: string, _trigger: HTMLElement) => workspace?.openReference({ workspaceId, path }),
    openUrl: (url: string) => workspace?.openUrl(url),
  }), [workspace, workspaceId, i18n.locale]);
  return <DocumentPreviewContext.Provider value={adapter}>{children}</DocumentPreviewContext.Provider>;
}
