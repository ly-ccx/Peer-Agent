import { useEffect, useMemo, useState } from 'react';
import { clientApi } from '../clientApi';
import { PeerIcon } from '../ui/icons';
import { isImeKey } from '../chat/state/compositionGuard';
import { useResourceRead } from '../ui/resources/useResourceState';
import { useWorkbench } from './WorkbenchContext';
import { useResourceWorkspace } from './ResourceWorkspaceContext';
import { resourceWebUrl } from './resourceWorkspaceState';
import { ResourceSearchResults } from './ResourceSearchResults';
import { documentComparisonLabel, normalizeDocumentComparison, type DocumentComparison } from './documentSessionState';

function RecentResource({ raw, active, isZh }: { readonly raw: string; readonly active: boolean; readonly isZh: boolean }) {
  const workspace = useResourceWorkspace();
  const descriptor = useMemo(() => {
    try {
      const value = JSON.parse(raw) as { kind?: string; path?: string; relativeTo?: string; url?: string; comparison?: DocumentComparison };
      if (value.kind === 'document' && typeof value.path === 'string') return { ...value, comparison: undefined };
      if (value.kind === 'comparison' && typeof value.path === 'string') {
        const comparison = normalizeDocumentComparison(value.comparison);
        if (comparison) return { ...value, comparison };
      }
      if (value.kind === 'browser' && typeof value.url === 'string' && resourceWebUrl(value.url)) return { ...value, comparison: undefined };
    } catch { /* Ignore unknown metadata. */ }
    return null;
  }, [raw]);
  const owner = workspace?.owner;
  const reference = owner && descriptor && ['document', 'comparison'].includes(descriptor.kind ?? '') ? { workspaceId: owner.workspaceId, path: descriptor.path!,
    ...(descriptor.relativeTo ? { relativeTo: descriptor.relativeTo } : {}), ...(descriptor.kind === 'comparison' ? { kind: 'directory' as const } : {}), metadataOnly: true } : null;
  const metadata = useResourceRead(JSON.stringify(reference), () => clientApi.readFile('', undefined, undefined, reference!), active && !!workspace?.ready && !!reference);
  if (!descriptor || !workspace?.ready) return null;
  if (descriptor.kind !== 'browser' && (!metadata.value?.ok || !metadata.value.metadataOnly || !metadata.value.resolvedPath)) return null;
  const path = metadata.value?.resolvedPath;
  return <button className="resource-recent" type="button" onClick={() => descriptor.kind === 'browser'
    ? workspace.openUrl(descriptor.url!) : descriptor.kind === 'comparison' && descriptor.comparison
      ? workspace.openComparison({ workspaceId: owner!.workspaceId, path: path!, kind: 'directory' }, descriptor.comparison)
      : workspace.openReference({ workspaceId: owner!.workspaceId, path: path!, ...(descriptor.relativeTo ? { relativeTo: descriptor.relativeTo } : {}) })}>
    <PeerIcon name={descriptor.kind === 'browser' ? 'globe' : 'fileText'} size={18} />
    <span>{descriptor.kind === 'browser' ? new URL(descriptor.url!).hostname : descriptor.comparison ? documentComparisonLabel(descriptor.comparison, isZh) : path?.split(/[\\/]/).pop()}</span>
  </button>;
}

export function ResourceLauncher({ isZh, active, recent, onChanges }: {
  readonly isZh: boolean; readonly active: boolean; readonly recent: readonly string[]; readonly onChanges: () => void;
}) {
  const workspace = useResourceWorkspace();
  const workbench = useWorkbench();
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState<{ query: string; candidates: readonly string[]; id: number } | null>(null);
  const intent = workspace?.searchIntent;
  useEffect(() => { if (intent) { setInput(intent.query); setSearch(intent); setNotice(''); } }, [intent?.id, intent?.query]);
  const submit = () => {
    if (!input.trim() || !workspace?.ready || !workspace.owner) return;
    const url = resourceWebUrl(input);
    if (url) { workspace.openUrl(url); setInput(''); return; }
    // Explicit paths resolve directly; filename/keyword discovery requires a scoped search.
    if (/[\\/]/.test(input.trim())) {
      workspace.openReference({ workspaceId: workspace.owner.workspaceId, path: input.trim() }); setInput('');
    } else {
      if (input.trim().length > 256) { setNotice(isZh ? '查找内容过长，请缩短文件名或输入完整路径。' : 'The query is too long. Shorten the filename or enter a complete path.'); return; }
      setSearch(previous => ({ query: input.trim(), candidates: [], id: (previous?.id ?? 0) + 1 })); setNotice('');
    }
  };
  return <section className="resource-launcher" aria-label={isZh ? '新标签页' : 'New tab'}>
    <form onSubmit={event => { event.preventDefault(); submit(); }}>
      <label className="resource-address"><PeerIcon name="search" size={18} />
        <input value={input} onChange={event => { setInput(event.target.value); setNotice(''); }} placeholder={isZh ? '输入网址、路径或查找文件' : 'Enter a URL, path or filename'}
          aria-label={isZh ? '网址或文件路径' : 'URL or file path'} onKeyDown={event => { if (event.key === 'Enter' && isImeKey(event.nativeEvent)) event.preventDefault(); }} />
        <button type="submit" className="resource-search-submit" aria-label={isZh ? '打开或查找' : 'Open or search'} title={isZh ? '打开或查找' : 'Open or search'}><PeerIcon name="arrowRight" size={16} /></button>
      </label>
    </form>
    {search ? <ResourceSearchResults key={workspace?.owner?.conversationId} query={search.query} candidates={search.candidates} requestId={search.id} active={active} isZh={isZh} /> : null}
    <h2>{isZh ? '工具' : 'Tools'}</h2>
    <div className="resource-launcher-tools">
      <button type="button" className="resource-tool" onClick={() => { workbench.setActiveTab('browser'); setNotice(''); }}><PeerIcon name="globe" size={18} /><span>{isZh ? '网页' : 'Browser'}</span><PeerIcon name="chevronRight" size={14} /></button>
      <button type="button" className="resource-tool" onClick={() => { workbench.setActiveTab('files'); setNotice(''); }}><PeerIcon name="folder" size={18} /><span>{isZh ? '文件与目录' : 'Files and folders'}</span><PeerIcon name="chevronRight" size={14} /></button>
      <button type="button" className="resource-tool" onClick={() => { setNotice(''); onChanges(); }}><PeerIcon name="fileText" size={18} /><span>{isZh ? '查看更改' : 'View changes'}</span><PeerIcon name="chevronRight" size={14} /></button>
    </div>
    {notice ? <p className="resource-launcher-notice" role="status">{notice}</p> : null}
    {workspace?.ready && recent.length ? <><h2>{isZh ? '最近' : 'Recent'}</h2><div className="resource-recent-list">
      {recent.map(raw => <RecentResource key={raw} raw={raw} active={active} isZh={isZh} />)}
    </div></> : null}
  </section>;
}
