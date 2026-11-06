import { ResourceSelectionFeedback } from './feedback/ResourceSelectionFeedback';
import { useComparisonReading } from './useComparisonReading';
import { OpenResourceWindowButton } from './OpenResourceWindowButton';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BotDocumentReference, ResourceWindowNavigation } from '@peer-agent/protocol';
import { clientApi } from '../clientApi';
import { useResourceWorkspace } from './ResourceWorkspaceContext';
import { useWorkbench } from './WorkbenchContext';
import { DiffViewer } from './file-preview/DiffViewer';
import { comparisonReadError, createFixedComparisonReader, resourceDiffFiles } from './resourceComparisonState';
import { normalizeDocumentRevision } from './documentRevisionState';
import { useComparisonRefresh } from './useComparisonRefresh';
import { useForegroundRefresh } from './useForegroundRefresh';
import { usePublishComparisonIndex } from './ComparisonNavigation';

export function ComparisonRead({ workspaceId, path, root, active, isZh, fromRef = 'HEAD', toRef, comparison, allowKeep = true, task, viewId = 'changes', initialReading, onRememberReading }: {
  readonly workspaceId: string; readonly path: string; readonly root: string; readonly active: boolean; readonly isZh: boolean;
  readonly fromRef?: string; readonly toRef?: string; readonly comparison?: 'working' | 'staged';
  readonly allowKeep?: boolean; readonly viewId?: string;
  readonly task?: BotDocumentReference['task'];
  readonly initialReading?: ResourceWindowNavigation;
  readonly onRememberReading?: (value: ResourceWindowNavigation) => void;
}) {
  const workspace = useResourceWorkspace();
  const workbench = useWorkbench();
  const [selection, setSelection] = useState<{ identity: string; key: string } | null>(null);
  const reference = { workspaceId, path, kind: 'directory' as const, ...(task ? { task } : {}) };
  const identity = JSON.stringify([reference, root, fromRef, toRef, comparison]);
  const selected = selection?.identity === identity ? selection.key : initialReading?.selected ?? null;
  const setSelected = useCallback((key: string) => setSelection({ identity, key }), [identity]);
  const readRange = useMemo(() => {
    const request = (range: { fromRef: string; toRef?: string }) => clientApi.gitDiffRange({
      workspaceRoot: root, ...range, ...(comparison ? { comparison } : {}), documentReference: reference,
    });
    return comparison ? () => request({ fromRef }) : createFixedComparisonReader({ fromRef, ...(toRef ? { toRef } : {}) }, request);
  }, [identity]);
  const read = useComparisonRefresh(identity, readRange, active);
  const automatic = useForegroundRefresh(identity, active && !read.error && (!!comparison || !toRef), read.observe);
  const value = read.value;
  const files = useMemo(() => resourceDiffFiles(value?.ok ? value.diffText : ''), [value]);
  const file = selected === null ? files[0] : files.find(item => item.key === selected);
  const confirmedRoot = value?.workspaceRoot ?? root;
  const index = useMemo(() => ({ workspaceId, identity, viewId, root: confirmedRoot, files, selected: file?.key ?? null, select: setSelected }), [workspaceId, identity, viewId, confirmedRoot, files, file?.key, setSelected]);
  usePublishComparisonIndex(index, active);
  const selectedHeading = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = selectedHeading.current;
    if (!active || selection?.identity !== identity || !node || !file) return;
    const scroller = node.closest<HTMLElement>('.resource-document-body, .resource-changes');
    if (scroller) scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, [selection]); // Only an explicit file choice locates its heading; background checks do not scroll.
  const repo = value?.workspaceRoot;
  const currentFile = repo && file?.path ? `${repo.replace(/[/\\]+$/, '')}/${file.path}` : null;
  const surface = useRef<HTMLElement>(null), body = useRef<HTMLDivElement>(null);
  const reading = useComparisonReading({ identity: `${viewId}:${identity}`, selected: file?.key ?? selected, ready: !!value?.ok && !!file, active, surface, body, initial: initialReading, onRemember: onRememberReading });
  return <section ref={surface} className="resource-comparison" aria-busy={read.loading}>
    <div className="resource-changes-toolbar">
      <span className="resource-source-label">{comparison === 'working' ? (isZh ? '暂存区 → 当前工作树' : 'Index → working tree')
        : comparison === 'staged' ? `HEAD → ${isZh ? '暂存区' : 'Index'}` : `${value?.fromRef ?? fromRef} → ${value?.toRef ?? (isZh ? '当前工作树' : 'Working tree')}`}</span>
      <button className="ui-button is-compact" type="button" disabled={read.loading} onClick={() => void read.reload()}>{isZh ? '刷新' : 'Refresh'}</button>
      {(!toRef || comparison) ? <button type="button" className="ui-button is-compact" title={isZh ? '仅在当前窗口前台检查；失败后可手动重试。' : 'Checks only while this window is in the foreground. Retry manually after a failure.'} aria-pressed={automatic.enabled} onClick={automatic.toggle}>{isZh ? '自动检查更新' : 'Check for updates automatically'}</button> : null}
      {value?.ok ? <OpenResourceWindowButton isZh={isZh} disabled={read.loading || read.error} request={() => ({ sourceTabId: viewId, resource: { kind: 'comparison', reference: { ...reference, path: root }, fromRef: comparison ? 'HEAD' : value.fromRef ?? fromRef, ...(value.toRef && !comparison ? { toRef: value.toRef } : {}), ...(comparison ? { comparison } : {}) }, navigation: reading.capture() })} /> : null}
      {allowKeep ? <button className="ui-button is-compact" type="button" disabled={!value?.ok || read.loading || read.error}
        onClick={() => { if (value?.ok) workspace?.openComparison({ ...reference, path: root }, {
          fromRef: value.fromRef ?? fromRef, ...(value.toRef ? { toRef: value.toRef } : {}), ...(comparison ? { comparison } : {}),
        }); }}>{isZh ? '在独立标签保留比较' : 'Keep comparison in a separate tab'}</button> : null}
    </div>
    <ResourceSelectionFeedback container={body} isZh={isZh} active={active && !!value?.ok && !read.loading}
      resource={value?.ok ? { kind: 'comparison', reference: { ...reference, path: root }, fromRef: comparison ? 'HEAD' : value.fromRef ?? fromRef,
        ...(value.toRef && !comparison ? { toRef: value.toRef } : {}), ...(comparison ? { comparison } : {}) } : null}
      digestText={value?.ok ? value.diffText : undefined} discussionPath={file?.path} />
    <p className="resource-source-label">{confirmedRoot}</p>
    {read.error ? <p role="alert">{comparisonReadError(read.failure?.status, read.failure?.error, isZh)}{value?.ok ? (isZh ? ' 仍显示上次读取的内容。' : ' Previous content is still shown.') : ''}</p> : null}
    {read.candidate ? <p className="resource-source-label" role="status">{isZh ? '此比较有新变更，当前阅读内容保留。' : 'This comparison has new changes. Your current reading is preserved.'}
      <button className="ui-button is-compact" type="button" disabled={read.loading} onClick={read.adopt}>{isZh ? '加载新变更' : 'Load new changes'}</button></p> : null}
    {selected !== null && value?.ok && !file ? <p className="resource-source-label" role="status">{isZh ? '所选文件已不在当前比较中，请重新选择。' : 'The selected file is no longer in this comparison. Choose another file.'}</p> : null}
    {!read.loaded && !read.error ? <p role="status">{isZh ? '正在读取更改…' : 'Reading changes…'}</p> : null}
    {value?.ok ? <>
      {files.length ? <>
        <nav className="resource-diff-index" aria-label={isZh ? '变更文件' : 'Changed files'}>
          {files.map(item => <button key={item.key} type="button" className="resource-diff-file" aria-pressed={file?.key === item.key} onClick={() => setSelected(item.key)}>
            <span>{item.path || (isZh ? '比较内容' : 'Comparison')}</span><small>{item.binary ? (isZh ? '二进制' : 'Binary') : `+${item.additions} / −${item.deletions}`}</small>
          </button>)}
        </nav>
        {file ? <>
          <div ref={selectedHeading} className="resource-changes-toolbar"><span className="resource-document-name" title={file.path}>{file.path}</span>
            <button type="button" className="ui-button is-compact" disabled={!currentFile || file.removed}
              title={file.removed ? (isZh ? '文件已删除，仍可阅读下面的变更。' : 'The file was deleted. Its changes remain readable below.') : undefined}
              onClick={() => { if (currentFile) workspace?.openReference({ ...reference, kind: 'file', path: currentFile }); }}>{isZh ? '打开当前文件' : 'Open current file'}</button>
            {!comparison && currentFile ? (['fromRef', 'toRef'] as const).map(endpoint => {
              const revision = normalizeDocumentRevision({ kind: 'git', commit: value[endpoint] });
              const absent = endpoint === 'fromRef' ? file.added : file.removed;
              const historicalPath = `${repo!.replace(/[/\\]+$/, '')}/${endpoint === 'fromRef' ? file.fromPath : file.path}`;
              return revision ? <button key={endpoint} type="button" className="ui-button is-compact" disabled={absent}
                title={absent ? (isZh ? '该文件在此比较端点不存在。' : 'This file does not exist at this comparison endpoint.') : undefined}
                onClick={() => workspace?.openReference({ ...reference, kind: 'file', path: historicalPath, revision })}>
                {endpoint === 'fromRef' ? (isZh ? '打开起点版本' : 'Open base version') : (isZh ? '打开终点版本' : 'Open target version')}</button> : null;
            }) : null}
          </div>
          {file.binary ? <p role="status">{isZh ? '这是二进制变更，无法显示文本差异。' : 'This is a binary change. Text differences are unavailable.'}</p>
            : <div ref={body}><DiffViewer diffText={file.raw} showFileHeaders showFileIndex={false} isZh={isZh} /></div>}
        </> : null}
      </> : <p role="status">{isZh ? '此范围没有已跟踪文件的改动。' : 'No tracked changes in this range.'}</p>}
      {value.untracked?.length ? <div className="resource-untracked"><h3>{isZh ? '未跟踪文件' : 'Untracked files'}</h3>
        {value.untracked.map(target => <button className="ui-button" type="button" key={target}
          onClick={() => workbench.openFile(target, undefined, undefined, { preferredMode: 'diff', reference: { ...reference, kind: 'file', path: target } })}>{target}</button>)}
        {value.untrackedTruncated ? <p role="status">{isZh ? '列表未完整显示，请在目录中继续查看。' : 'The list is incomplete. Continue in Files.'}</p> : null}
      </div> : null}
    </> : null}
  </section>;
}
