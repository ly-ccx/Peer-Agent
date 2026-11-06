import { clientApi } from '../clientApi';
import { useState } from 'react';
import { PeerIcon } from '../ui/icons';
import { useResourceRead } from '../ui/resources/useResourceState';
import { useResourceWorkspace } from './ResourceWorkspaceContext';

export function ResourceSearchResults({ query, candidates = [], requestId, active, isZh }: {
  readonly query: string; readonly candidates?: readonly string[]; readonly requestId: number;
  readonly active: boolean; readonly isZh: boolean;
}) {
  const workspace = useResourceWorkspace();
  const [source, setSource] = useState('.');
  const reference = { workspaceId: workspace?.owner?.workspaceId ?? '', path: source, kind: 'directory' as const };
  const result = useResourceRead(JSON.stringify([reference, query, requestId]), async () => {
    if (!clientApi.searchWorkspaceFiles) throw new Error('search_unavailable');
    // An old preload ignores the fourth argument. An empty legacy root fails closed.
    return clientApi.searchWorkspaceFiles('', query, 40, reference);
  }, active && !!workspace?.ready && !candidates.length);
  const open = (path: string, kind: 'file' | 'directory' = 'file') => {
    if (workspace?.owner) workspace.openReference({ workspaceId: workspace.owner.workspaceId, path, kind });
  };
  if (candidates.length) return <section className="resource-search-results" aria-label={isZh ? '选择文件位置' : 'Choose file location'}>
    <p className="resource-launcher-notice">{isZh ? '这条回复引用了多个同名文件，请选择位置。' : 'This reply references several files with this name. Choose a location.'}</p>
    {candidates.map(path => <button key={path} className="resource-search-hit" type="button" onClick={() => open(path)}>
      <PeerIcon name="fileText" size={16} /><span>{path}</span>
    </button>)}
  </section>;
  const value = result.value?.scoped === true && (!result.value.ok || !!result.value.workspacePath) ? result.value : null;
  return <section className="resource-search-results" aria-label={isZh ? '查找结果' : 'Search results'} aria-busy={result.loading}>
    <div className="resource-search-scope" role="group" aria-label={isZh ? '查找范围' : 'Search scope'}>
      <button className="ui-button is-compact" type="button" aria-pressed={source === '.'} onClick={() => setSource('.')}>{isZh ? '当前项目' : 'Project'}</button>
      <button className="ui-button is-compact" type="button" aria-pressed={source === 'Peer-Knowledge'} onClick={() => setSource('Peer-Knowledge')}>{isZh ? '知识库' : 'Knowledge'}</button>
      <button className="ui-button is-compact" type="button" disabled={result.loading} onClick={() => void result.reload()}>{isZh ? '重新查找' : 'Search again'}</button>
    </div>
    <p className="resource-launcher-notice">{isZh ? `“${query}”的查找结果` : `Results for “${query}”`}</p>
    {!result.loaded && !result.error ? <p role="status">{isZh ? '正在查找…' : 'Searching…'}</p>
      : result.error || !value ? <p role="alert">{isZh ? '本机查找暂不可用，请在应用更新生效后重试。' : 'Local search is unavailable. Retry after the application update takes effect.'}</p>
        : !value.ok ? <p role="alert">{value.status === 'permission_denied' || value.status === 'scope_denied'
          ? (isZh ? '当前无法访问这个查找范围。' : 'This search scope is not accessible.')
          : (isZh ? '无法读取这个来源，请检查位置后重试。' : 'Unable to read this source. Check its location and retry.')}</p>
          : <>
            {value.workspacePath ? <p className="resource-source-label">{value.workspacePath}</p> : null}
            {!value.files.length ? <p role="status">{isZh ? '此范围内未找到匹配项。可补全路径或切换查找范围。' : 'No matches in this scope. Refine the path or choose another scope.'}</p> : null}
            {value.files.map(hit => <button className="resource-search-hit" type="button" key={`${hit.kind}:${hit.relPath}`}
              onClick={() => open(`${value.workspacePath!.replace(/[/\\]+$/, '')}/${hit.relPath}`, hit.kind)}>
              <PeerIcon name={hit.kind === 'directory' ? 'folder' : 'fileText'} size={16} /><span>{hit.relPath}</span>
            </button>)}
            {value.truncated ? <p className="resource-launcher-notice" role="status">{isZh ? '结果未完整显示，请补全文件名或缩小范围后继续查找。' : 'Results are incomplete. Refine the filename or narrow the scope.'}</p> : null}
          </>}
  </section>;
}
