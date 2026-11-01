import { EditDraftButton } from './editing/EditDraftButton';
import { ResourceSelectionFeedback } from './feedback/ResourceSelectionFeedback';
import { documentReadError } from './documentReadError';
export { documentReadError } from './documentReadError';
import { OpenResourceWindowButton } from './OpenResourceWindowButton';
import { RasterImageView } from './file-preview/RasterImageView';
import { documentAdapterNotice } from './file-preview/documentAdapterState';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
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
import { PeerIcon } from '../ui/icons';
import { ResourceDocumentHeader } from './ResourceDocumentHeader';
import { ResourceReadState } from './ResourceReadState';
import { useMotionAllowed } from '../app/hooks/useMotionAllowed';
import './document-reading.css';

export function ScopedDocumentPage({ tab, active, workspaceId, isZh, onModeChange, onObservation, onReadingChange }: {
  readonly tab: DocumentTabSession; readonly active: boolean; readonly workspaceId: string; readonly isZh: boolean;
  readonly onModeChange: (id: string, mode: WorkbenchFileMode) => void;
  readonly onObservation?: (id: string, value: LocalDocumentObservation) => void;
  readonly onReadingChange?: (id: string, key: string, point: DocumentReadPosition) => void;
}) {
  const workspace = useResourceWorkspace();
  const modeId = useId();
  const motionAllowed = useMotionAllowed();
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
    <ResourceDocumentHeader path={path} relativePath={loaded?.resolvedPath === path ? loaded?.observation?.relativePath : undefined} historical={Boolean(reference.revision)}
      mode={tab.mode} idPrefix={modeId} isZh={isZh} onModeChange={mode => onModeChange(tab.id, mode)}
      history={<DocumentHistoryTools reference={reference} path={path} confirmed={loaded?.revision} isZh={isZh} hidden={tab.mode === 'diff'} />}
      actions={<>
      <EditDraftButton iconOnly active={active && ready && !busy} isZh={isZh} text={loaded?.media === 'text' ? loaded.content : undefined}
        source={tab.mode !== 'diff' && !reference.revision && loaded?.ok && loaded.media === 'text' && loaded.observation ? { kind: 'document', reference: { ...reference, path, relativeTo: undefined }, observed: { resourceId: loaded.observation.resourceId, contentVersion: loaded.observation.contentVersion } } : null}
        onOpen={session => { const draft = session.snapshot().view?.draft; if (draft) workspace?.openDraft(draft); }} />
      <OpenResourceWindowButton isZh={isZh} disabled={!ready || busy} request={() => ({ sourceTabId: tab.id, resource: { kind: 'document', reference: { ...reference, path,
        ...(loaded?.observation && tab.mode !== 'diff' ? { expectedObservation: { resourceId: loaded.observation.resourceId, contentVersion: loaded.observation.contentVersion } } : {}) },
        ...(tab.mode === 'diff' ? { mode: 'diff', comparison } : { mode: tab.mode }), ...(tab.navigation?.line && !reading.ref.current ? { line: tab.navigation.line } : {}), ...(tab.delivery ? { delivery: tab.delivery } : {}) },
        ...(reading.ref.current ? { navigation: { top: reading.ref.current.scrollTop, left: reading.ref.current.scrollLeft } } : {}) })} />
      <button className="ui-button is-icon" type="button" disabled={busy} onClick={refresh} aria-label={isZh ? '刷新' : 'Refresh'} title={isZh ? '刷新' : 'Refresh'}>
        <PeerIcon name={busy ? 'loader' : 'repeat'} size={16} className={busy && active && motionAllowed ? 'motion-spin' : undefined} /></button>
    </>} />
    <ResourceSelectionFeedback container={reading.ref} isZh={isZh} active={active && ready && !busy}
      resource={ready && (tab.mode === 'diff' || loaded?.media === 'text' && (loaded.observation || loaded.revision)) ? { kind: 'document', reference: { ...reference, path }, ...(tab.mode === 'diff' ? { mode: 'diff', comparison } : { mode: tab.mode }) } : null}
      version={tab.mode !== 'diff' && loaded?.media === 'text' ? loaded.revision ? { kind: 'git', commit: loaded.revision.commit }
        : loaded.observation ? { kind: 'content', resourceId: loaded.observation.resourceId, contentVersion: loaded.observation.contentVersion } : undefined : undefined}
      digestText={tab.mode === 'diff' && diff.value?.ok ? diff.value.diffText : undefined}
      sourceContent={tab.mode === 'source' && loaded?.media === 'text' ? loaded.content : undefined} />
    {tab.mode !== 'diff' && documentAdapterNotice(path, isZh) ? <p className="resource-adapter-notice" role="status">{documentAdapterNotice(path, isZh)}</p> : null}
    {loaded?.ok && loaded.media === 'text' && tab.mode === 'preview' && kind === 'json' && formattedJson === null ? <p className="resource-adapter-notice" role="status">{isZh ? '未应用 JSON 排版，按原始文本显示。' : 'JSON formatting was not applied. Original source text is shown.'}</p> : null}
    {tab.delivery ? <DocumentDeliveryTools binding={tab.delivery} reference={reference} active={active} isZh={isZh} /> : null}
    {tab.mode !== 'diff' && failure ? <div className="resource-document-notice" role={loaded || failure.status === 'version_changed' ? 'status' : 'alert'}>
      {failure.status === 'not_file' && reference.revision ? (isZh ? '此提交中的路径是目录，暂不支持历史目录浏览。' : 'This path is a directory in this commit. Historical directory browsing is unavailable.')
        : failure.status === 'version_unavailable' && reference.revision ? (isZh ? '本机 Git 或读取服务不支持安全的历史版本读取，请检查更新后重试。' : 'The local Git or reader cannot safely read historical versions. Check for updates and retry.')
        : failure.status === 'not_found' && reference.revision ? (isZh ? '此提交中不存在这个路径，未使用当前文件替代。' : 'This path does not exist in this commit. The current file was not substituted.')
        : failure.status === 'version_changed' && loaded ? (isZh ? '文件已更新，仍保留当前阅读内容。' : 'The file changed. Your current reading is preserved.') : documentReadError(failure.status, isZh)}
      {failure.status === 'version_changed' && !reference.revision ? <button className="ui-button is-compact" type="button" disabled={busy} onClick={() => void document.loadCurrent()}>{isZh ? '加载当前版本' : 'Load current version'}</button> : null}
      {failure.candidates?.map(candidate => <button key={candidate.path} type="button" className="resource-candidate"
        onClick={() => workspace?.openReference({ ...reference, path: candidate.path, relativeTo: undefined })}>{candidate.path}</button>)}
    </div> : null}
    {ready && tab.mode === 'source' && reading.missingLine ? <p className="resource-document-notice" role="status">{isZh ? '引用的行号不在当前已显示范围，已保留正常阅读位置。' : 'The referenced line is outside the currently displayed range. The reading position is preserved.'}</p> : null}
    <div ref={reading.ref} onScroll={reading.onScroll} className="resource-document-body" aria-busy={busy}
      id={`${modeId}-panel`} role="tabpanel" aria-labelledby={`${modeId}-tab-${tab.mode}`}>
      {tab.mode === 'diff' ? <>
        <label className="resource-document-comparison">{isZh ? '比较范围' : 'Compare'}<select className="ui-input" value={comparison} aria-label={isZh ? '比较基准' : 'Comparison base'} onChange={event => setComparison(event.target.value as 'working' | 'staged')}>
          <option value="working">{isZh ? '暂存区 → 工作树' : 'Index → working tree'}</option><option value="staged">{isZh ? 'HEAD → 暂存区' : 'HEAD → index'}</option>
        </select></label>
        {!resolved ? <ResourceReadState active={active} kind={metadata.loaded || metadata.error ? 'error' : 'loading'}
          title={metadata.loaded || metadata.error ? (isZh ? '暂时无法核对来源' : 'Unable to confirm the source') : (isZh ? '正在核对比较来源' : 'Checking comparison source')}
          detail={metadata.loaded || metadata.error ? documentReadError(metadata.value?.status, isZh) : undefined} />
          : diff.value?.ok ? diff.value.diffText ? <DiffViewer diffText={diff.value.diffText} showFileIndex={false} isZh={isZh} />
            : <ResourceReadState kind="empty" title={isZh ? '没有代码差异' : 'No code differences'} detail={isZh ? '当前比较范围没有改动。' : 'There are no changes in this comparison.'} />
            : <ResourceReadState active={active} kind={diff.loaded || diff.error ? 'error' : 'loading'}
              title={isZh ? (diff.loaded || diff.error ? '暂时无法读取差异' : '正在读取代码差异') : (diff.loaded || diff.error ? 'Unable to read differences' : 'Reading code differences')}
              detail={diff.loaded || diff.error ? documentReadError(diff.value?.status, isZh) : undefined} />}
      </> : loaded?.ok ? loaded.media === 'image'
        ? <RasterImageView dataUrl={loaded.dataUrl ?? ''} name={path.split(/[\\/]/).pop() ?? ''} isZh={isZh} onReady={reading.restore} onRetry={() => void document.reload()} />
        : <DocumentPreviewContext.Provider value={nested}>{kind === 'markdown' && tab.mode === 'preview'
          ? <MarkdownDocument isZh={isZh} content={loaded.content ?? ''} emptyLabel={isZh ? '文档为空。' : 'The document is empty.'} copyLabel={isZh ? '复制' : 'Copy'} copiedLabel={isZh ? '已复制' : 'Copied'} />
          : <SourceViewer isZh={isZh} content={kind === 'json' && tab.mode === 'preview' ? formattedJson ?? loaded.content ?? '' : loaded.content ?? ''} language={highlightLanguageForPath(path)} emptyLabel={isZh ? '文件为空。' : 'The file is empty.'} />}</DocumentPreviewContext.Provider>
        : !failure && !document.error ? <ResourceReadState active={active} title={isZh ? '正在读取文件' : 'Reading file'}
          detail={isZh ? '正在核对文件来源与内容。' : 'Checking the file source and content.'} /> : null}
      {(tab.mode === 'diff' ? metadata.error || diff.error : document.error) ? <p className="resource-document-notice" role="alert">{isZh ? '读取未确认，已有阅读内容保留。可重试。' : 'The read was not confirmed. Existing reading is preserved. Retry.'}</p> : null}
    </div>
  </section>;
}
