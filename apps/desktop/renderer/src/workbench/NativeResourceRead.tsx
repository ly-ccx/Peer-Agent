import { PeerIcon } from '../ui/icons';
import { EditDraftButton } from './editing/EditDraftButton';
import { ResourceEditor } from './editing/ResourceEditor';
import type { ResourceEditSession } from './editing/resourceEditSession';
import { ResourceSelectionFeedback } from './feedback/ResourceSelectionFeedback';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ResourceWindowContext, ResourceWindowReadRequest } from '@peer-agent/protocol';
import { createNativeResourceReader } from './nativeResourceReadState';
import { SourceViewer } from './file-preview/SourceViewer';
import { MarkdownDocument } from './file-preview/MarkdownDocument';
import { RasterImageView } from './file-preview/RasterImageView';
import { DiffViewer } from './file-preview/DiffViewer';
import { detectFileKind, formatJsonForPreview, highlightLanguageForPath } from './file-preview/fileTypes';
import { documentAdapterNotice } from './file-preview/documentAdapterState';
import { LocalDocumentRenderingContext } from '../chat/components/markdown/DocumentPreviewContext';
import { documentReadError } from './documentReadError';
import { useDocumentReadingPosition } from './useDocumentReadingPosition';
import { documentComparisonLabel } from './documentSessionState';
import { useNativeNavigation } from './NativeNavigation';
import { FilesView } from './views/FilesView';
import type { DirectoryReading } from './directorySessionState';

export function useNativeRead(context: ResourceWindowContext, operation: ResourceWindowReadRequest['operation'], path?: string) {
  const key = JSON.stringify([context.viewId, context.windowId, context.generation, operation, path]);
  const reader = useMemo(() => createNativeResourceReader({ identity: { viewId: context.viewId, windowId: context.windowId, generation: context.generation }, operation, ...(path ? { path } : {}) },
    request => window.peerResource!.read(request)), [key]);
  const state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  useEffect(() => { void reader.reload(); return () => reader.cancel(); }, [reader]);
  return { ...state, reload: reader.reload, loadCurrent: reader.loadCurrent };
}
export function ReadingNotice({ read, isZh, children }: { readonly read: ReturnType<typeof useNativeRead>; readonly isZh: boolean; readonly children?: ReactNode }) {
  return <>
    <div className="resource-native-read-actions"><button type="button" className="ui-button is-compact" disabled={read.loading} onClick={() => void read.reload()}>{isZh ? '刷新' : 'Refresh'}</button>{children}</div>
    {read.failure ? <p className="resource-source-label" role="alert">{documentReadError(read.failure, isZh)}{read.value ? (isZh ? ' 已保留上次阅读内容。' : ' Previous reading is preserved.') : ''}
      {read.failure === 'version_changed' ? <button type="button" className="ui-button is-compact" disabled={read.loading} onClick={() => void read.loadCurrent()}>{isZh ? '加载当前版本' : 'Load current version'}</button> : null}</p> : null}
    {!read.loaded ? <p role="status">{isZh ? '正在读取…' : 'Reading…'}</p> : null}
  </>;
}
export function NativeResourceDocument({ context, isZh, path, initialPositions, onPositions }: { readonly context: ResourceWindowContext; readonly isZh: boolean; readonly path?: string;
  readonly initialPositions?: Readonly<Record<string, { top: number; left: number }>>; readonly onPositions?: (positions: Readonly<Record<string, { top: number; left: number }>>) => void }) {
  const navigation = useNativeNavigation();
  const [draft, setDraft] = useState<ResourceEditSession | null>(null);
  const diff = context.resource.kind === 'comparison' || context.resource.kind === 'document' && context.resource.mode === 'diff';
  const read = useNativeRead(context, diff ? 'diff' : 'content', path);
  const target = path ?? context.resource.reference.path;
  const [mode, setMode] = useState<'preview' | 'source'>(context.navigation?.mode ?? (context.resource.kind === 'document' && context.resource.mode === 'source' ? 'source' : 'preview'));
  const value = read.value?.document, kind = detectFileKind(target);
  const content = useMemo(() => kind === 'json' && mode === 'preview' ? formatJsonForPreview(value?.content ?? '') ?? value?.content ?? '' : value?.content ?? '', [kind, mode, value?.content]);
  const modeKey = diff ? 'diff' : mode;
  const remembered = useRef<Record<string, { top: number; left: number }>>(initialPositions ? { ...initialPositions } : Object.fromEntries(context.navigation?.positions?.map(point => [point.key, { top: point.top, left: point.left }]) ?? []));
  const remember = useCallback((key: string, point: { top: number; left: number }) => {
    remembered.current = { ...remembered.current, [key]: point }; onPositions?.(remembered.current);
    if (!path) navigation?.update({ ...point, ...(!diff ? { mode } : {}), positions: Object.entries(remembered.current).map(([key, value]) => ({ key, ...value })) });
  }, [navigation, path, mode, diff, onPositions]);
  const reading = useDocumentReadingPosition(`${context.viewId}:${target}`, diff ? 'diff' : mode, true, !!read.value,
    context.resource.kind === 'document' && context.resource.line && !context.navigation ? { line: context.resource.line, requestId: context.viewId } : undefined,
    { key: modeKey, initial: { ...remembered.current, ...(context.navigation && !path && !remembered.current[modeKey] ? { [modeKey]: context.navigation } : {}) }, onRemember: remember });
  useLayoutEffect(() => {
    if (path || !navigation) return;
    const capture = () => {
      if (!read.value) return;
      const point = reading.capture();
      return { ...point, ...(!diff ? { mode } : {}), positions: Object.entries(reading.snapshot()).map(([key, value]) => ({ key, ...value })) };
    };
    const dispose = navigation.registerCapture(capture);
    const value = capture(); if (value) navigation.update(value);
    return dispose;
  }, [navigation, path, mode, diff, !!read.value]);
  useLayoutEffect(() => { if (!draft) reading.restore(); }, [!!draft, reading.restore]);
  const comparison = context.resource.kind === 'comparison' ? context.resource : context.resource.kind === 'document' && context.resource.mode === 'diff' ? { fromRef: 'HEAD', comparison: context.resource.comparison } : null;
  const canPreview = kind === 'markdown';
  const sourceContent = !diff && value?.media === 'text' && !(canPreview && mode === 'preview') && content === value.content ? value.content : undefined;
  if (draft) return <ResourceEditor key={`${draft.workspaceId}:${draft.draftId}`} session={draft} active isZh={isZh}
    source={draft.source ?? (!diff && value?.observation ? { kind: 'native', identity: { viewId: context.viewId, windowId: context.windowId, generation: context.generation }, ...(path ? { path } : {}), observed: { resourceId: value.observation.resourceId, contentVersion: value.observation.contentVersion } } : undefined)}
    onNewBase={setDraft} onReturn={() => { setDraft(null); void read.loadCurrent(); }} onDiscarded={() => setDraft(null)} />;
  return <section className="resource-native-reading" aria-busy={read.loading}>
    <ReadingNotice read={read} isZh={isZh}><EditDraftButton active={!read.loading} isZh={isZh} text={value?.media === 'text' ? value.content : undefined}
      source={!diff && !context.resource.reference.revision && value?.media === 'text' && value.observation ? { kind: 'native', identity: { viewId: context.viewId, windowId: context.windowId, generation: context.generation }, ...(path ? { path } : {}), observed: { resourceId: value.observation.resourceId, contentVersion: value.observation.contentVersion } } : null} onOpen={setDraft} />{!diff && canPreview ? <div role="group" aria-label={isZh ? '文档模式' : 'Document mode'}>{(['preview', 'source'] as const).map(value => <button key={value} type="button" className="ui-button is-compact" aria-pressed={mode === value} onClick={() => setMode(value)}>{value === 'source' ? (isZh ? '源码' : 'Source') : (isZh ? '正文' : 'Preview')}</button>)}</div> : null}</ReadingNotice>
    <ResourceSelectionFeedback container={reading.ref} isZh={isZh} active={!read.loading && !!read.value}
      resource={diff ? context.resource : value?.media === 'text' && (value.observation || value.revision) ? { kind: 'document', mode: sourceContent !== undefined ? 'source' : 'preview', reference: { ...context.resource.reference, kind: 'file', path: target,
        ...(value.observation ? { expectedObservation: { resourceId: value.observation.resourceId, contentVersion: value.observation.contentVersion } } : {}) } } : null}
      version={!diff && value?.media === 'text' ? value.revision ? { kind: 'git', commit: value.revision.commit } : value.observation ? { kind: 'content', resourceId: value.observation.resourceId, contentVersion: value.observation.contentVersion } : undefined : undefined}
      digestText={diff && read.value?.diff ? JSON.stringify(read.value.diff) : undefined} sourceContent={sourceContent} />
    {!diff && documentAdapterNotice(target, isZh) ? <p className="resource-adapter-notice">{documentAdapterNotice(target, isZh)}</p> : null}
    {context.resource.kind === 'document' && context.resource.delivery ? <p className="resource-source-label">{isZh ? '正在查看当前文件；原交付依据保留在原会话中。' : 'Viewing the current file. Original delivery evidence remains in the source conversation.'}</p> : null}
    <div ref={reading.ref} onScroll={reading.onScroll} className="resource-document-body">
    {diff ? read.value?.diff ? <><p className="resource-source-label">{comparison ? documentComparisonLabel(comparison, isZh) : ''}</p>
      {read.value.diff.diffText ? <DiffViewer diffText={read.value.diff.diffText} isZh={isZh} /> : <p>{isZh ? '此比较没有已跟踪文件的差异。' : 'No tracked file differences in this comparison.'}</p>}
      {read.value.diff.untracked?.length ? <details><summary><PeerIcon name="chevronRight" size={12} />{isZh ? '未跟踪文件（不包含在上述 Diff 中）' : 'Untracked files (not included in the diff above)'}</summary><ul>{read.value.diff.untracked.map(path => <li key={path}>{path}</li>)}</ul></details> : null}
      {read.value.diff.untrackedTruncated ? <p role="status">{isZh ? '未跟踪文件列表已截断。' : 'The untracked file list is truncated.'}</p> : null}</> : null
      : value ? value.media === 'image' ? <RasterImageView dataUrl={value.dataUrl ?? ''} name={target} isZh={isZh} onReady={reading.restore} onRetry={() => void read.reload()} />
        : <LocalDocumentRenderingContext.Provider value={true}>{kind === 'markdown' && mode === 'preview'
          ? <MarkdownDocument content={value.content} isZh={isZh} emptyLabel={isZh ? '文档为空。' : 'Empty document.'} copyLabel={isZh ? '复制' : 'Copy'} copiedLabel={isZh ? '已复制' : 'Copied'} />
          : <SourceViewer content={content} language={highlightLanguageForPath(target)} isZh={isZh} emptyLabel={isZh ? '文件为空。' : 'Empty file.'} />}</LocalDocumentRenderingContext.Provider> : null}
    </div>
  </section>;
}

export function NativeResourceDirectory({ context, isZh }: { readonly context: ResourceWindowContext; readonly isZh: boolean }) {
  const root = context.resource.reference.path, navigation = useNativeNavigation()!;
  const [selected, setSelected] = useState<string | null>(null);
  const positions = useRef(new Map<string, Readonly<Record<string, { top: number; left: number }>>>());
  const initial = useMemo<DirectoryReading>(() => ({ root, task: context.owner.task, expanded: context.navigation?.expanded ?? ['.'],
    selected: context.navigation?.selected ?? null, filter: context.navigation?.filter ?? '', top: context.navigation?.top ?? 0, left: context.navigation?.left ?? 0 }), [context.viewId]);
  const remember = useCallback((reading: DirectoryReading) => navigation.update({ top: reading.top, left: reading.left, expanded: reading.expanded,
    ...(reading.selected ? { selected: reading.selected } : {}), filter: reading.filter }), [navigation]);
  const bindCapture = useCallback((capture: () => DirectoryReading | undefined) => navigation.registerCapture(() => {
    const reading = capture(); return reading ? { top: reading.top, left: reading.left, expanded: reading.expanded, ...(reading.selected ? { selected: reading.selected } : {}), filter: reading.filter } : undefined;
  }), [navigation]);
  const readDirectory = useCallback(async (path: string) => {
    const result = await window.peerResource!.read({ identity: context, operation: 'directory', path });
    return { ok: result.ok && !!result.directory, status: result.status, entries: result.directory?.entries ?? [], truncated: result.directory?.truncated };
  }, [context]);
  const rememberPositions = useCallback((value: Readonly<Record<string, { top: number; left: number }>>) => {
    if (!selected) return; positions.current.delete(selected); positions.current.set(selected, value);
    while (positions.current.size > 12) positions.current.delete(positions.current.keys().next().value!);
  }, [selected]);
  return <div className="resource-native-directory">
    <section className="resource-native-list"><FilesView isZh={isZh} workspacePath={root} botWorkspaceId={context.owner.workspaceId} task={context.owner.task}
      reading={initial} readScopedDirectory={readDirectory} onOpenFile={setSelected} onReadingReady={bindCapture} onRememberReading={remember} /></section>
    {selected ? <section className="resource-native-selection" key={selected}><p className="resource-source-label">{selected}</p>
      <NativeResourceDocument context={context} path={selected} isZh={isZh} initialPositions={positions.current.get(selected)} onPositions={rememberPositions} /></section> : null}
  </div>;
}
