import { useCallback, useMemo, useRef, useState } from 'react';
import type { LocalDocumentObservation } from '@peer-agent/protocol';
import { useObservedDocument } from './useObservedDocument';
import { clientApi } from '../clientApi';
import { useResourceRead } from '../ui/resources/useResourceState';
import { DocumentPreviewContext } from '../chat/components/markdown/DocumentPreviewContext';
import { MarkdownDocument } from './file-preview/MarkdownDocument';
import { SourceViewer } from './file-preview/SourceViewer';
import { DiffViewer } from './file-preview/DiffViewer';
import { detectFileKind, highlightLanguageForPath } from './file-preview/fileTypes';
import { useResourceWorkspace } from './ResourceWorkspaceContext';
import type { DocumentReadPosition, DocumentTabSession, WorkbenchFileMode } from './documentSessionState';
import { useDocumentReadingPosition } from './useDocumentReadingPosition';

export function documentReadError(status: string | undefined, zh: boolean): string {
  const labels: Record<string, readonly [string, string]> = {
    version_unavailable: ['当前读取服务不能核对内容版本，请更新本机服务后重试。', 'The local reader cannot confirm content versions. Update it and retry.'],
    version_changed: ['文件已更新，尚未加载当前版本。', 'The file has changed. The current version has not been loaded.'],
    source_changed: ['文件来源已变化，请关闭此标签后从原允许来源重新打开。', 'The file source changed. Close this tab and reopen it from an allowed source.'],
    not_found: ['未能按此引用定位文件，请检查来源和完整路径。', 'The reference could not locate the file. Check its source and complete path.'],
    permission_denied: ['当前没有读取权限。', 'Reading this resource is not permitted.'],
    scope_denied: ['目标超出当前已确认的来源范围。', 'The target is outside the confirmed source scope.'],
    workspace_unavailable: ['项目或知识库来源当前不可用。', 'The project or knowledge source is unavailable.'],
    ambiguous_path: ['有多个匹配来源，请明确选择文件位置。', 'Multiple sources match. Choose an explicit location.'],
    relative_base_required: ['这个相对路径需要明确来源，请选择位置。', 'This relative path needs an explicit source. Choose a location.'],
    not_file: ['这是目录，请从工作区的目录入口浏览。', 'This is a directory. Open it from Files.'],
    too_large: ['内容超出预览限额，未作为完整正文加载。', 'This resource exceeds the preview limit and was not loaded as complete content.'],
    binary: ['此二进制格式暂不支持正文预览。', 'Text preview is unavailable for this binary format.'],
    invalid_path: ['引用路径无效。', 'The reference path is invalid.'],
    not_git_repo: ['此文件不在 Git 仓库中，无法比较。', 'This file is not in a Git repository.'],
    unsupported_type: ['此格式暂不支持图片预览。', 'Image preview is unavailable for this format.'],
  };
  return labels[status ?? '']?.[zh ? 0 : 1] ?? (zh ? '读取失败，可重试。' : 'Reading failed. You can retry.');
}

export function ScopedDocumentPage({ tab, active, workspaceId, isZh, onModeChange, onObservation, onReadingChange }: {
  readonly tab: DocumentTabSession; readonly active: boolean; readonly workspaceId: string; readonly isZh: boolean;
  readonly onModeChange: (id: string, mode: WorkbenchFileMode) => void;
  readonly onObservation?: (id: string, value: LocalDocumentObservation) => void;
  readonly onReadingChange?: (id: string, key: string, point: DocumentReadPosition) => void;
}) {
  const workspace = useResourceWorkspace();
  const [comparison, setComparison] = useState<'working' | 'staged'>('working');
  const live = useRef(active); live.current = active;
  const reference = useMemo(() => ({ workspaceId, path: tab.reference?.path ?? tab.absPath,
    ...(tab.reference?.task ? { task: tab.reference.task } : {}),
    ...(tab.reference?.relativeTo ? { relativeTo: tab.reference.relativeTo } : {}) }), [workspaceId, tab.reference, tab.absPath]);
  const identity = JSON.stringify([workspaceId, tab.id, reference]);
  const rememberObservation = useCallback((value: LocalDocumentObservation) => onObservation?.(tab.id, value), [tab.id, onObservation]);
  const rememberPosition = useCallback((key: string, point: DocumentReadPosition) => onReadingChange?.(tab.id, key, point), [tab.id, onReadingChange]);
  const document = useObservedDocument(identity, reference, active && tab.mode !== 'diff', tab.observation, rememberObservation);
  const loaded = document.value;
  const metadata = useResourceRead(`meta:${identity}`, () => clientApi.readFile('', undefined, undefined, { ...reference, metadataOnly: true }), active && tab.mode === 'diff');
  const resolved = metadata.value?.ok && metadata.value.metadataOnly && metadata.value.resolvedPath ? { ...reference, path: metadata.value.resolvedPath } : null;
  const diff = useResourceRead(`diff:${identity}:${resolved?.path}:${comparison}`, () => clientApi.gitDiff('', undefined, undefined, resolved!, comparison), active && tab.mode === 'diff' && !!resolved);
  const path = tab.mode === 'diff' ? resolved?.path ?? reference.path : loaded?.resolvedPath ?? reference.path;
  const kind = detectFileKind(path);
  const ready = tab.mode === 'diff' ? !!diff.value?.ok : !!loaded?.ok;
  const reading = useDocumentReadingPosition(identity, tab.mode === 'diff' ? `diff:${comparison}` : tab.mode, active, ready, tab.navigation, {
    key: tab.mode === 'diff' ? `diff:${comparison}` : `${loaded?.observation?.contentVersion ?? 'unconfirmed'}:${tab.mode}`,
    initial: tab.readingPositions, onRemember: rememberPosition,
  });
  const busy = tab.mode === 'diff' ? metadata.loading || diff.loading : document.loading;
  const refreshKey = `${identity}:${tab.mode}:${comparison}`;
  const latestRefresh = useRef(refreshKey); latestRefresh.current = refreshKey;
  const nested = useMemo(() => ({ label: isZh ? '打开文档' : 'Open document',
    open: (value: string) => workspace?.openReference({ ...reference, path: value, ...(loaded?.resolvedPath ? { relativeTo: loaded.resolvedPath } : {}) }),
    openUrl: (value: string) => workspace?.openUrl(value), remoteImages: 'link' as const,
    remoteImageLabel: isZh ? '打开外部图片' : 'Open external image',
  }), [workspace, reference, loaded?.resolvedPath, isZh]);
  const refresh = async () => {
    if (tab.mode !== 'diff') { await document.reload(); return; }
    const previous = metadata.snapshot().value?.resolvedPath;
    if (!await metadata.reload() || !live.current || latestRefresh.current !== refreshKey) return;
    const next = metadata.snapshot().value;
    if (next?.ok && next.metadataOnly && next.resolvedPath === previous) await diff.reload();
  };
  const failure = document.failure;
  return <section className="document-page resource-document" data-active={active} inert={!active} aria-hidden={!active} aria-label={path}>
    <header className="resource-document-toolbar">
      <span className="resource-document-name" title={path}>{path.split(/[\\/]/).pop()}</span>
      <div role="group" aria-label={isZh ? '文档模式' : 'Document mode'}>
        {(['preview', 'source', 'diff'] as const).map(mode => <button key={mode} type="button" className="ui-button" aria-pressed={tab.mode === mode}
          disabled={kind === 'image' && mode === 'source'} title={kind === 'image' && mode === 'source' ? (isZh ? '图片不提供文本源码。' : 'Images have no text source view.') : undefined}
          onClick={() => onModeChange(tab.id, mode)}>{mode === 'preview' ? (isZh ? '正文' : 'Preview') : mode === 'source' ? (isZh ? '源码' : 'Source') : 'Diff'}</button>)}
      </div>
      <button className="ui-button" type="button" disabled={busy} onClick={refresh}>{isZh ? '刷新' : 'Refresh'}</button>
    </header>
    <p className="resource-source-label">{path}</p>
    {tab.mode !== 'diff' && failure ? <div className="resource-source-label" role={loaded || failure.status === 'version_changed' ? 'status' : 'alert'}>
      {failure.status === 'version_changed' && loaded ? (isZh ? '文件已更新，仍保留当前阅读内容。' : 'The file changed. Your current reading is preserved.') : documentReadError(failure.status, isZh)}
      {failure.status === 'version_changed' ? <button className="ui-button is-compact" type="button" disabled={busy} onClick={() => void document.loadCurrent()}>{isZh ? '加载当前版本' : 'Load current version'}</button> : null}
      {failure.candidates?.map(candidate => <button key={candidate.path} type="button" className="resource-candidate"
        onClick={() => workspace?.openReference({ ...reference, path: candidate.path, relativeTo: undefined })}>{candidate.path}</button>)}
    </div> : null}
    {ready && tab.mode === 'source' && reading.missingLine ? <p className="resource-source-label" role="status">{isZh ? '引用的行号超出当前文件范围，已保留正常阅读位置。' : 'The referenced line is outside the current file. The reading position is preserved.'}</p> : null}
    <div ref={reading.ref} onScroll={reading.onScroll} className="resource-document-body" aria-busy={busy}>
      {tab.mode === 'diff' ? <>
        <select value={comparison} aria-label={isZh ? '比较基准' : 'Comparison base'} onChange={event => setComparison(event.target.value as 'working' | 'staged')}>
          <option value="working">{isZh ? '暂存区 → 工作树' : 'Index → working tree'}</option><option value="staged">{isZh ? 'HEAD → 暂存区' : 'HEAD → index'}</option>
        </select>
        {!resolved ? <p role={metadata.loaded || metadata.error ? 'alert' : 'status'}>{metadata.loaded || metadata.error ? documentReadError(metadata.value?.status, isZh) : (isZh ? '正在核对比较来源…' : 'Checking comparison source…')}</p>
          : diff.value?.ok ? diff.value.diffText ? <DiffViewer diffText={diff.value.diffText} showFileIndex={false} isZh={isZh} /> : <p>{isZh ? '当前比较范围没有改动。' : 'No changes in this comparison.'}</p>
            : <p role={diff.loaded || diff.error ? 'alert' : 'status'}>{diff.loaded || diff.error ? documentReadError(diff.value?.status, isZh) : (isZh ? '正在读取 Diff…' : 'Reading Diff…')}</p>}
      </> : loaded?.ok ? loaded.media === 'image'
        ? <img className="resource-image" src={loaded.dataUrl} onLoad={reading.restore} alt={path.split(/[\\/]/).pop() ?? ''} />
        : <DocumentPreviewContext.Provider value={nested}>{kind === 'markdown' && tab.mode === 'preview'
          ? <MarkdownDocument content={loaded.content ?? ''} emptyLabel={isZh ? '文档为空。' : 'The document is empty.'} copyLabel={isZh ? '复制' : 'Copy'} copiedLabel={isZh ? '已复制' : 'Copied'} />
          : <SourceViewer content={loaded.content ?? ''} language={highlightLanguageForPath(path)} emptyLabel={isZh ? '文件为空。' : 'The file is empty.'} />}</DocumentPreviewContext.Provider>
        : !failure && !document.error ? <p role="status">{isZh ? '正在核对并读取文档…' : 'Resolving document…'}</p> : null}
      {(tab.mode === 'diff' ? metadata.error || diff.error : document.error) ? <p role="alert">{isZh ? '读取未确认，已有阅读内容保留。可重试。' : 'The read was not confirmed. Existing reading is preserved. Retry.'}</p> : null}
    </div>
  </section>;
}
