import { OpenResourceWindowButton } from './OpenResourceWindowButton';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkbench } from './WorkbenchContext';
import { EMPTY_DIRECTORY_SESSION, directoryReadingKey, rememberDirectoryReading, type DirectoryReading } from './directorySessionState';
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
  const { directorySessions, setDirectorySession } = useWorkbench();
  const capture = useRef<(() => DirectoryReading | undefined) | null>(null);
  const bindCapture = useCallback((next: () => DirectoryReading | undefined) => { capture.current = next; return () => { if (capture.current === next) capture.current = null; }; }, []);
  const workspaceId = workspace?.owner?.workspaceId ?? '';
  const session = directorySessions[workspaceId] ?? EMPTY_DIRECTORY_SESSION;
  const [changesSource, setChangesSource] = useState('.');
  const directory = workspace?.directoryIntent;
  const task = changes ? undefined : directory ? directory.task : session.task;
  const invalidSource = !changes && !directory && session.invalidSource;
  const relativeTo = changes ? undefined : directory ? directory.relativeTo : session.relativeTo;
  const source = changes ? changesSource : directory?.path ?? session.source;
  const setSource = useCallback((path: string, resetTask = false) => {
    if (changes) setChangesSource(path);
    else setDirectorySession(workspaceId, current => ({ ...current, source: path, relativeTo: undefined, ...(resetTask ? { task: undefined, invalidSource: undefined } : {}) }));
  }, [changes, workspaceId, setDirectorySession]);
  const rememberReading = useCallback((reading: DirectoryReading) => {
    setDirectorySession(workspaceId, current => rememberDirectoryReading(current, reading));
  }, [workspaceId, setDirectorySession]);
  useEffect(() => { if (!changes && directory) { setDirectorySession(workspaceId, current => ({ ...current, source: directory.path, task: directory.task, relativeTo: directory.relativeTo, invalidSource: undefined })); workspace?.consumeDirectoryIntent(directory.id); } }, [changes, directory?.id, directory?.path, directory?.task?.sessionId, directory?.task?.planId, directory?.relativeTo, setDirectorySession, workspaceId]);
  const reference = { workspaceId, path: source, ...(task ? { task } : {}), ...(relativeTo ? { relativeTo } : {}), kind: 'directory' as const, metadataOnly: true };
  const metadata = useResourceRead(JSON.stringify(reference), () => clientApi.readFile('', undefined, undefined, reference), active && !!workspace?.ready && !invalidSource);
  const ready = !invalidSource && !!workspace?.ready && !metadata.error && metadata.value?.ok && metadata.value.metadataOnly && metadata.value.resolvedPath;
  const allowedRoot = metadata.value?.ok ? metadata.value.resolvedFrom : undefined;
  const relative = ready && allowedRoot && ready.replace(/\\/g, '/').startsWith(`${allowedRoot.replace(/\\/g, '/').replace(/\/$/, '')}/`)
    ? ready.replace(/\\/g, '/').slice(allowedRoot.replace(/\\/g, '/').replace(/\/$/, '').length + 1).split('/') : [];
  return <div className="resource-navigator">
    <div className="resource-source-picker">
      <button className="ui-button" type="button" aria-pressed={source === '.' && !task} onClick={() => setSource('.', true)}>{isZh ? '当前项目' : 'Project'}</button>
      <button className="ui-button" type="button" aria-pressed={source === 'Peer-Knowledge' && !task} onClick={() => setSource('Peer-Knowledge', true)}>{isZh ? '知识库' : 'Knowledge'}</button>
      <button className="ui-button" type="button" disabled={!!invalidSource} onClick={() => { if (!invalidSource) void metadata.reload(); }}>{isZh ? '重新核对来源' : 'Recheck source'}</button>
      {!changes && ready ? <OpenResourceWindowButton isZh={isZh} request={() => { const reading = capture.current?.(); return { resource: { kind: 'directory', reference: { workspaceId, path: ready, kind: 'directory', ...(task ? { task } : {}) } },
        ...(reading ? { navigation: { top: reading.top, left: reading.left, expanded: reading.expanded, ...(reading.selected ? { selected: reading.selected } : {}), filter: reading.filter } } : {}) }; }} /> : null}
    </div>
    {!changes && ready && allowedRoot ? <nav className="resource-directory-breadcrumbs" aria-label={isZh ? '目录位置' : 'Directory location'}>
      <button type="button" onClick={() => setSource(allowedRoot)}>{allowedRoot.split(/[/\\]/).filter(Boolean).at(-1) || allowedRoot}</button>
      {relative.map((part, index) => <span key={index}><PeerIcon name="chevronRight" size={12} />
        <button type="button" aria-current={index === relative.length - 1 ? 'location' : undefined}
          onClick={() => setSource(`${allowedRoot.replace(/[/\\]+$/, '')}/${relative.slice(0, index + 1).join('/')}`)}>{part}</button></span>)}
    </nav> : null}
    {invalidSource ? <p role="alert">{isZh ? '此目录的来源记录已失效。请重新从原处打开，或明确选择其他来源。' : 'The saved directory source is invalid. Reopen it from its origin or choose another source.'}</p> : metadata.loading && !metadata.loaded ? <p role="status">{isZh ? '正在核对来源…' : 'Checking source…'}</p> : ready
      ? changes ? <ResourceChanges key={ready} isZh={isZh} workspaceId={workspaceId} path={source} root={ready} active={active} />
        : <FilesView key={`${workspaceId}:${ready}:${task?.sessionId ?? ''}:${task?.planId ?? ''}`} isZh={isZh} workspacePath={ready} botWorkspaceId={workspaceId} task={task} active={active}
            reading={session.readings.find(reading => directoryReadingKey(reading) === directoryReadingKey({ root: ready, task }))} onRememberReading={rememberReading} onReadingReady={bindCapture} />
      : metadata.loaded || metadata.error ? <p role="alert">{source}: {sourceReadError(metadata.value?.status, isZh)}</p> : null}
  </div>;
}
