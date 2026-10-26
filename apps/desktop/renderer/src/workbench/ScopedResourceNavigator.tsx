import { useEffect, useState } from 'react';
import { clientApi } from '../clientApi';
import { useResourceRead } from '../ui/resources/useResourceState';
import { useResourceWorkspace } from './ResourceWorkspaceContext';
import { FilesView } from './views/FilesView';
import { ResourceChanges } from './ResourceChanges';
import { PeerIcon } from '../ui/icons';

function sourceReadError(status: string | undefined, isZh: boolean): string {
  const messages: Record<string, readonly [string, string]> = {
    permission_denied: ['当前没有读取此来源的权限。', 'Reading this source is not permitted.'],
    scope_denied: ['此来源超出当前允许的访问范围。', 'This source is outside the permitted scope.'],
    not_found: ['找不到此来源，请检查项目或知识库的位置。', 'This source was not found. Check the project or knowledge location.'],
    workspace_unavailable: ['当前项目或知识库不可用，请检查其位置后重试。', 'The project or knowledge source is unavailable. Check its location and retry.'],
    invalid_path: ['来源路径无效，请重新选择。', 'This source path is invalid. Choose another source.'],
  };
  return messages[status ?? '']?.[isZh ? 0 : 1] ?? (isZh ? '暂时无法读取此来源，请重试。' : 'Unable to read this source. Please retry.');
}

export function ScopedResourceNavigator({ isZh, changes = false, active }: { readonly isZh: boolean; readonly changes?: boolean; readonly active: boolean }) {
  const workspace = useResourceWorkspace();
  const [source, setSource] = useState('.');
  const directory = workspace?.directoryIntent;
  useEffect(() => { if (!changes && directory) setSource(directory.path); }, [changes, directory?.id, directory?.path]);
  const workspaceId = workspace?.owner?.workspaceId ?? '';
  const reference = { workspaceId, path: source, kind: 'directory' as const, metadataOnly: true };
  const metadata = useResourceRead(JSON.stringify(reference), () => clientApi.readFile('', undefined, undefined, reference), active && !!workspace?.ready);
  const ready = metadata.value?.ok && metadata.value.metadataOnly && metadata.value.resolvedPath;
  const allowedRoot = metadata.value?.ok ? metadata.value.resolvedFrom : undefined;
  const relative = ready && allowedRoot && ready.replace(/\\/g, '/').startsWith(`${allowedRoot.replace(/\\/g, '/').replace(/\/$/, '')}/`)
    ? ready.replace(/\\/g, '/').slice(allowedRoot.replace(/\\/g, '/').replace(/\/$/, '').length + 1).split('/') : [];
  return <div className="resource-navigator">
    <div className="resource-source-picker">
      <button className="ui-button" type="button" aria-pressed={source === '.'} onClick={() => setSource('.')}>{isZh ? '当前项目' : 'Project'}</button>
      <button className="ui-button" type="button" aria-pressed={source === 'Peer-Knowledge'} onClick={() => setSource('Peer-Knowledge')}>{isZh ? '知识库' : 'Knowledge'}</button>
      <button className="ui-button" type="button" onClick={() => { void metadata.reload(); }}>{isZh ? '重新核对来源' : 'Recheck source'}</button>
    </div>
    {!changes && ready && allowedRoot ? <nav className="resource-directory-breadcrumbs" aria-label={isZh ? '目录位置' : 'Directory location'}>
      <button type="button" onClick={() => setSource(allowedRoot)}>{allowedRoot.split(/[/\\]/).filter(Boolean).at(-1) || allowedRoot}</button>
      {relative.map((part, index) => <span key={index}><PeerIcon name="chevronRight" size={12} />
        <button type="button" aria-current={index === relative.length - 1 ? 'location' : undefined}
          onClick={() => setSource(`${allowedRoot.replace(/[/\\]+$/, '')}/${relative.slice(0, index + 1).join('/')}`)}>{part}</button></span>)}
    </nav> : null}
    {metadata.loading && !metadata.loaded ? <p role="status">{isZh ? '正在核对来源…' : 'Checking source…'}</p> : ready
      ? changes ? <ResourceChanges key={ready} isZh={isZh} workspaceId={workspaceId} path={source} root={ready} active={active} />
        : <FilesView key={`${workspaceId}:${ready}`} isZh={isZh} workspacePath={ready} botWorkspaceId={workspaceId} />
      : metadata.loaded || metadata.error ? <p role="alert">{sourceReadError(metadata.value?.status, isZh)}</p> : null}
  </div>;
}
