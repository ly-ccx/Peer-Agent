import { useEffect, useState } from 'react';
import { useResourceWorkspace } from '../ResourceWorkspaceContext';
import { useWorkbench } from '../WorkbenchContext';
import { closeDocumentTab, type DocumentTabSession } from '../documentSessionState';
import { ResourceEditor } from './ResourceEditor';
import { resourceEditRegistry } from './resourceEditRegistry';
import type { ResourceEditSession } from './resourceEditSession';
export function DraftDocumentPage({ tab, active, workspaceId, isZh }: { readonly tab: DocumentTabSession; readonly active: boolean; readonly workspaceId: string; readonly isZh: boolean }) {
  const workspace = useResourceWorkspace(), workbench = useWorkbench(), identity = JSON.stringify([workspaceId, tab.draftId, tab.absPath]);
  const [entry, setEntry] = useState<{ key: string; session: ResourceEditSession | null } | null>(null);
  useEffect(() => {
    const valid = !!tab.draftId && tab.reference?.workspaceId === workspaceId;
    setEntry({ key: identity, session: valid ? resourceEditRegistry()?.get(workspaceId, tab.draftId!, { expectedPath: tab.absPath }) ?? null : null });
  }, [identity, workspaceId, tab.draftId, tab.reference?.workspaceId, tab.absPath]);
  const session = entry?.key === identity ? entry.session : null;
  return <section className="document-page resource-document" data-active={active} inert={!active} aria-hidden={!active}>
    {session ? <ResourceEditor key={`${session.workspaceId}:${session.draftId}`} session={session} active={active} isZh={isZh} onNewBase={value => { const draft = value.snapshot().view?.draft; if (draft) workspace?.openDraft(draft); }}
      onDiscarded={() => workbench.setDocumentSession(current => closeDocumentTab(current, tab.id))} />
      : <p role={entry?.key === identity ? 'alert' : 'status'}>{entry?.key === identity ? (isZh ? '无法恢复这份本机草稿。请回到所属 Bot 的草稿列表重新打开。' : 'This local draft cannot be restored. Reopen it from its owning Bot’s drafts.') : (isZh ? '正在打开本机草稿…' : 'Opening local draft…')}</p>}
  </section>;
}
