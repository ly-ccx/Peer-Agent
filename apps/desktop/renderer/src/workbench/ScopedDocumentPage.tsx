import { EditDraftButton } from './editing/EditDraftButton';
import { ResourceSelectionFeedback } from './feedback/ResourceSelectionFeedback';
import { documentReadError } from './documentReadError';
export { documentReadError } from './documentReadError';
import { OpenResourceWindowButton } from './OpenResourceWindowButton';
import { RasterImageView } from './file-preview/RasterImageView';
import { adapterModeUnavailable, documentAdapterNotice, isPackagedDocument } from './file-preview/documentAdapterState';
import { ExternalDocumentActions } from './file-preview/ExternalDocumentActions';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { LocalDocumentObservation } from '@peer-agent/protocol';
import { useObservedDocument } from './useObservedDocument';
import { clientApi } from '../clientApi';
import { useResourceRead } from '../ui/resources/useResourceState';
import { DocumentPreviewContext } from '../chat/components/markdown/DocumentPreviewContext';
import { MarkdownDocument } from './file-preview/MarkdownDocument';
import { SourceViewer } from './file-preview/SourceViewer';
import { DiffViewer } from './file-preview/DiffViewer';
import { detectFileKind, formatJsonForPreview, highlightLanguageForPath } from './file-preview/fileTypes';
import { useResourceWorkspace } from './ResourceWorkspaceContext';
import type { DocumentReadPosition, DocumentTabSession, WorkbenchFileMode } from './documentSessionState';
import { useDocumentReadingPosition } from './useDocumentReadingPosition';
import { DocumentHistoryTools } from './DocumentHistoryTools';
import { DocumentDeliveryTools } from './DocumentDeliveryTools';
import { nestedDocumentReference } from './documentRevisionState';

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
    ...(tab.reference?.revision ? { revision: tab.reference.revision } : {}),
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
  const formattedJson = useMemo(() => kind === 'json' && tab.mode === 'preview' && loaded?.media === 'text'
    ? formatJsonForPreview(loaded.content ?? '') : null, [kind, tab.mode, loaded?.media, loaded?.content]);
  const ready = tab.mode === 'diff' ? !!diff.value?.ok : !!loaded?.ok;
  const reading = useDocumentReadingPosition(identity, tab.mode === 'diff' ? `diff:${comparison}` : tab.mode, active, ready, tab.navigation, {
    key: tab.mode === 'diff' ? `diff:${comparison}` : `${loaded?.observation?.contentVersion ?? 'unconfirmed'}:${tab.mode}`,
    initial: tab.readingPositions, onRemember: rememberPosition,
  });
  const busy = tab.mode === 'diff' ? metadata.loading || diff.loading : document.loading;
  const refreshKey = `${identity}:${tab.mode}:${comparison}`;
  const latestRefresh = useRef(refreshKey); latestRefresh.current = refreshKey;
  const nested = useMemo(() => ({ label: isZh ? '打开文档' : 'Open document',
    open: (value: string) => workspace?.openReference(nestedDocumentReference(reference, value, loaded?.resolvedPath, loaded?.revision)),
    openUrl: (value: string) => workspace?.openUrl(value), remoteImages: 'link' as const,
    remoteImageLabel: isZh ? '打开外部图片' : 'Open external image',
  }), [workspace, reference, loaded?.resolvedPath, loaded?.revision, isZh]);
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
          disabled={adapterModeUnavailable(path, mode) || !!reference.revision && mode === 'diff'} title={mode === 'preview' && adapterModeUnavailable(path, mode) ? (isZh ? '此格式仅提供只读源码。' : 'Only read-only source is available for this format.') : kind === 'image' && mode === 'source' ? (isZh ? '图片不提供文本源码。' : 'Images have no text source view.')
            : reference.revision && mode === 'diff' ? (isZh ? '历史正文只读；请从提交比较查看差异。' : 'Historical content is read-only. Use a commit comparison for differences.') : undefined}
          onClick={() => onModeChange(tab.id, mode)}>{mode === 'preview' ? (isZh ? '正文' : 'Preview') : mode === 'source' ? (isZh ? '源码' : 'Source') : 'Diff'}</button>)}
      </div>
      <EditDraftButton active={active && ready && !busy} isZh={isZh} text={loaded?.media === 'text' ? loaded.content : undefined}
        source={tab.mode !== 'diff' && !reference.revision && loaded?.ok && loaded.media === 'text' && loaded.observation ? { kind: 'document', reference: { ...reference, path, relativeTo: undefined }, observed: { resourceId: loaded.observation.resourceId, contentVersion: loaded.observation.contentVersion } } : null}
        onOpen={session => { const draft = session.snapshot().view?.draft; if (draft) workspace?.openDraft(draft); }} />
      <OpenResourceWindowButton isZh={isZh} disabled={!ready || busy} request={() => ({ sourceTabId: tab.id, resource: { kind: 'document', reference: { ...reference, path,
        ...(loaded?.observation && tab.mode !== 'diff' ? { expectedObservation: { resourceId: loaded.observation.resourceId, contentVersion: loaded.observation.contentVersion } } : {}) },
        ...(tab.mode === 'diff' ? { mode: 'diff', comparison } : { mode: tab.mode }), ...(tab.navigation?.line && !reading.ref.current ? { line: tab.navigation.line } : {}), ...(tab.delivery ? { delivery: tab.delivery } : {}) },
        ...(reading.ref.current ? { navigation: { top: reading.ref.current.scrollTop, left: reading.ref.current.scrollLeft } } : {}) })} />
      <button className="ui-button" type="button" disabled={busy} onClick={refresh}>{isZh ? '刷新' : 'Refresh'}</button>
    </header>
    <ResourceSelectionFeedback container={reading.ref} isZh={isZh} active={active && ready && !busy}
      resource={ready && (tab.mode === 'diff' || loaded?.media === 'text' && (loaded.observation || loaded.revision)) ? { kind: 'document', reference: { ...reference, path }, ...(tab.mode === 'diff' ? { mode: 'diff', comparison } : { mode: tab.mode }) } : null}
      version={tab.mode !== 'diff' && loaded?.media === 'text' ? loaded.revision ? { kind: 'git', commit: loaded.revision.commit }
        : loaded.observation ? { kind: 'content', resourceId: loaded.observation.resourceId, contentVersion: loaded.observation.contentVersion } : undefined : undefined}
      digestText={tab.mode === 'diff' && diff.value?.ok ? diff.value.diffText : undefined}
      sourceContent={tab.mode === 'source' && loaded?.media === 'text' ? loaded.content : undefined} />
    <p className="resource-source-label">{path}</p>
    {tab.mode !== 'diff' && !isPackagedDocument(path) && documentAdapterNotice(path, isZh) ? <p className="resource-adapter-notice" role="status">{documentAdapterNotice(path, isZh)}</p> : null}
    {loaded?.ok && loaded.media === 'text' && tab.mode === 'preview' && kind === 'json' && formattedJson === null ? <p className="resource-adapter-notice" role="status">{isZh ? '未应用 JSON 排版，按原始文本显示。' : 'JSON formatting was not applied. Original source text is shown.'}</p> : null}
    <DocumentHistoryTools reference={reference} path={path} confirmed={loaded?.revision} isZh={isZh} hidden={tab.mode === 'diff'} />
    {tab.delivery ? <DocumentDeliveryTools binding={tab.delivery} reference={reference} active={active} isZh={isZh} /> : null}
    {tab.mode !== 'diff' && failure ? <div className="resource-source-label" role={loaded || failure.status === 'version_changed' ? 'status' : 'alert'}>
      {failure.status === 'binary' && isPackagedDocument(failure.resolvedPath || path) ? <>
        <span>{isZh ? '此格式不能在这里预览正文。' : 'This format cannot be previewed here.'}</span>
        {failure.resolvedPath ? <ExternalDocumentActions path={failure.resolvedPath} workspaceRoot={failure.resolvedFrom} isZh={isZh} /> : null}
      </> : failure.status === 'not_found' && !reference.revision ? <>
        <span>{failure.attemptedRoot
          ? (isZh ? `未能按此引用定位文件。已在这个项目根查找：${failure.attemptedRoot}` : `The reference could not locate the file. Looked in this project root: ${failure.attemptedRoot}`)
          : documentReadError('not_found', isZh)}</span>
        <button type="button" className="ui-button is-compact" onClick={() => workspace?.locate(reference.path)}>{isZh ? '查找文件位置' : 'Find file location'}</button>
      </> : failure.status === 'not_file' && reference.revision ? (isZh ? '此提交中的路径是目录，暂不支持历史目录浏览。' : 'This path is a directory in this commit. Historical directory browsing is unavailable.')
        : failure.status === 'version_unavailable' && reference.revision ? (isZh ? '本机 Git 或读取服务不支持安全的历史版本读取，请检查更新后重试。' : 'The local Git or reader cannot safely read historical versions. Check for updates and retry.')
        : failure.status === 'not_found' && reference.revision ? (isZh ? '此提交中不存在这个路径，未使用当前文件替代。' : 'This path does not exist in this commit. The current file was not substituted.')
        : failure.status === 'version_changed' && loaded ? (isZh ? '文件已更新，仍保留当前阅读内容。' : 'The file changed. Your current reading is preserved.') : documentReadError(failure.status, isZh)}
      {failure.status === 'version_changed' && !reference.revision ? <button className="ui-button is-compact" type="button" disabled={busy} onClick={() => void document.loadCurrent()}>{isZh ? '加载当前版本' : 'Load current version'}</button> : null}
      {failure.candidates?.map(candidate => <button key={candidate.path} type="button" className="resource-candidate"
        onClick={() => workspace?.openReference({ ...reference, path: candidate.path, relativeTo: undefined })}>{candidate.path}</button>)}
    </div> : null}
    {ready && tab.mode === 'source' && reading.missingLine ? <p className="resource-source-label" role="status">{isZh ? '引用的行号不在当前已显示范围，已保留正常阅读位置。' : 'The referenced line is outside the currently displayed range. The reading position is preserved.'}</p> : null}
    <div ref={reading.ref} onScroll={reading.onScroll} className="resource-document-body" aria-busy={busy}>
      {tab.mode === 'diff' ? <>
        <select value={comparison} aria-label={isZh ? '比较基准' : 'Comparison base'} onChange={event => setComparison(event.target.value as 'working' | 'staged')}>
          <option value="working">{isZh ? '暂存区 → 工作树' : 'Index → working tree'}</option><option value="staged">{isZh ? 'HEAD → 暂存区' : 'HEAD → index'}</option>
        </select>
        {!resolved ? <p role={metadata.loaded || metadata.error ? 'alert' : 'status'}>{metadata.loaded || metadata.error ? documentReadError(metadata.value?.status, isZh) : (isZh ? '正在核对比较来源…' : 'Checking comparison source…')}</p>
          : diff.value?.ok ? diff.value.diffText ? <DiffViewer diffText={diff.value.diffText} showFileIndex={false} isZh={isZh} /> : <p>{isZh ? '当前比较范围没有改动。' : 'No changes in this comparison.'}</p>
            : <p role={diff.loaded || diff.error ? 'alert' : 'status'}>{diff.loaded || diff.error ? documentReadError(diff.value?.status, isZh) : (isZh ? '正在读取 Diff…' : 'Reading Diff…')}</p>}
      </> : loaded?.ok ? loaded.media === 'image'
        ? <RasterImageView dataUrl={loaded.dataUrl ?? ''} name={path.split(/[\\/]/).pop() ?? ''} isZh={isZh} onReady={reading.restore} onRetry={() => void document.reload()} />
        : <DocumentPreviewContext.Provider value={nested}>{kind === 'markdown' && tab.mode === 'preview'
          ? <MarkdownDocument isZh={isZh} content={loaded.content ?? ''} emptyLabel={isZh ? '文档为空。' : 'The document is empty.'} copyLabel={isZh ? '复制' : 'Copy'} copiedLabel={isZh ? '已复制' : 'Copied'} />
          : <SourceViewer isZh={isZh} content={kind === 'json' && tab.mode === 'preview' ? formattedJson ?? loaded.content ?? '' : loaded.content ?? ''} language={highlightLanguageForPath(path)} emptyLabel={isZh ? '文件为空。' : 'The file is empty.'} />}</DocumentPreviewContext.Provider>
        : !failure && !document.error ? <p role="status">{isZh ? '正在核对并读取文档…' : 'Resolving document…'}</p> : null}
      {(tab.mode === 'diff' ? metadata.error || diff.error : document.error) ? <p role="alert">{isZh ? '读取未确认，已有阅读内容保留。可重试。' : 'The read was not confirmed. Existing reading is preserved. Retry.'}</p> : null}
    </div>
  </section>;
}
