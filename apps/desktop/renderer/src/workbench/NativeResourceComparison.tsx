import { PeerIcon } from '../ui/icons';
import { ResourceSelectionFeedback } from './feedback/ResourceSelectionFeedback';
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import type { ResourceWindowContext } from '@peer-agent/protocol';
import { useNativeRead, ReadingNotice } from './NativeResourceRead';
import { useNativeNavigation } from './NativeNavigation';
import { useDocumentReadingPosition } from './useDocumentReadingPosition';
import { resourceDiffFiles } from './resourceComparisonState';
import { documentComparisonLabel } from './documentSessionState';
import { prepareDiffPresentation } from './file-preview/diffPresentationState';
import { DiffViewer } from './file-preview/DiffViewer';

export function NativeResourceComparison({ context, isZh }: { readonly context: ResourceWindowContext; readonly isZh: boolean }) {
  const navigation = useNativeNavigation()!, read = useNativeRead(context, 'diff');
  const [selected, setSelected] = useState<string | null>(context.navigation?.selected ?? null);
  const presentation = useMemo(() => prepareDiffPresentation(read.value?.diff?.diffText ?? ''), [read.value]);
  const allFiles = useMemo(() => presentation.mode === 'unified' ? resourceDiffFiles(presentation.text) : [], [presentation]);
  const files = allFiles.slice(0, 512), file = selected === null ? null : files.find(file => file.key === selected);
  const modeKey = selected === null ? 'all' : `file:${selected}`;
  const initial = useMemo(() => Object.fromEntries(context.navigation?.positions?.map(point => [point.key, { top: point.top, left: point.left }]) ?? [[modeKey, context.navigation ?? { top: 0, left: 0 }]]), [context.viewId]);
  const remember = useCallback((key: string, point: { top: number; left: number }) => {
    const positions = navigation.current().positions?.filter(value => value.key !== key) ?? [];
    navigation.update({ ...point, ...(selected !== null ? { selected } : {}), positions: [...positions, { key, ...point }].slice(-12) });
  }, [navigation, selected]);
  const canRestore = !!read.value && (selected === null || !!file);
  const reading = useDocumentReadingPosition(context.viewId, 'comparison', true, canRestore, undefined, { key: modeKey, initial, onRemember: remember });
  useLayoutEffect(() => {
    const capture = () => canRestore ? { ...reading.capture(), ...(selected !== null ? { selected } : {}), positions: Object.entries(reading.snapshot()).map(([key, point]) => ({ key, ...point })) } : undefined;
    const dispose = navigation.registerCapture(capture); const value = capture(); if (value) navigation.update(value);
    return dispose;
  }, [navigation, selected, canRestore]);
  const choose = (key: string | null) => { reading.capture(); setSelected(key); };
  return <section className="resource-native-reading" aria-busy={read.loading}>
    <ReadingNotice read={read} isZh={isZh} />
    <ResourceSelectionFeedback container={reading.ref} resource={context.resource} isZh={isZh} active={!read.loading && !!read.value?.diff}
      digestText={read.value?.diff ? JSON.stringify(read.value.diff) : undefined} discussionPath={file?.path} />
    <p className="resource-source-label">{context.resource.kind === 'comparison' ? documentComparisonLabel(context.resource, isZh) : ''}</p>
    {files.length ? <nav className="resource-native-comparison-index" aria-label={isZh ? '比较文件' : 'Comparison files'}>
      <button className="ui-button is-compact" type="button" aria-pressed={selected === null} onClick={() => choose(null)}>{isZh ? '全部差异' : 'All differences'}</button>
      {files.map(file => <button className="ui-button is-compact" key={file.key} type="button" aria-pressed={selected === file.key} onClick={() => choose(file.key)}>{file.path}</button>)}
    </nav> : null}
    {allFiles.length > 512 ? <p role="status">{isZh ? '文件索引仅列前 512 项；可切换全部差异阅读。' : 'The file index shows 512 entries. Read all differences for the remainder.'}</p> : null}
    {selected !== null && !file && read.value ? <p role="status">{isZh ? '上次选择不在当前可用的文件索引中，请重新选择。' : 'The previous selection is not in the available file index. Choose a file.'}<button className="ui-button is-compact" type="button" onClick={() => choose(null)}>{isZh ? '查看全部差异' : 'Read all differences'}</button></p> : null}
    <div className="resource-document-body" ref={reading.ref} onScroll={reading.onScroll}>
      {read.value?.diff ? selected === null ? read.value.diff.diffText ? <DiffViewer diffText={read.value.diff.diffText} isZh={isZh} /> : <p>{isZh ? '没有已跟踪文件的差异。' : 'No tracked file differences.'}</p>
        : file ? <DiffViewer diffText={file.raw} isZh={isZh} /> : null : null}
      {selected === null && read.value?.diff?.untracked?.length ? <details><summary><PeerIcon name="chevronRight" size={12} />{isZh ? '未跟踪文件（未包含在 Diff 中）' : 'Untracked files (outside the diff)'}</summary><ul>{read.value.diff.untracked.map(path => <li key={path}>{path}</li>)}</ul></details> : null}
      {read.value?.diff?.untrackedTruncated ? <p role="status">{isZh ? '未跟踪文件列表已截断。' : 'The untracked file list is truncated.'}</p> : null}
    </div>
  </section>;
}
