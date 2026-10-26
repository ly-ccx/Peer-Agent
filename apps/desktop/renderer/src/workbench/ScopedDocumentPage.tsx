import { useMemo, useRef, useState } from 'react';
import { clientApi } from '../clientApi';
import { useResourceRead } from '../ui/resources/useResourceState';
import { DocumentPreviewContext } from '../chat/components/markdown/DocumentPreviewContext';
import { MarkdownDocument } from './file-preview/MarkdownDocument';
import { SourceViewer } from './file-preview/SourceViewer';
import { DiffViewer } from './file-preview/DiffViewer';
import { detectFileKind, highlightLanguageForPath } from './file-preview/fileTypes';
import { useResourceWorkspace } from './ResourceWorkspaceContext';
import type { DocumentTabSession, WorkbenchFileMode } from './documentSessionState';
import { useDocumentReadingPosition } from './useDocumentReadingPosition';

export function documentReadError(status: string | undefined, zh: boolean): string {
  const labels: Record<string, readonly [string, string]> = {
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

export function ScopedDocumentPage({ tab, active, workspaceId, isZh, onModeChange }: {
  readonly tab: DocumentTabSession; readonly active: boolean; readonly workspaceId: string; readonly isZh: boolean;
  readonly onModeChange: (id: string, mode: WorkbenchFileMode) => void;
}) {
  const workspace = useResourceWorkspace();
  const [comparison, setComparison] = useState<'working' | 'staged'>('working');
  const live = useRef(active); live.current = active;
  // Restored renderer metadata never chooses a different Bot's authority.
  const reference = useMemo(() => ({ workspaceId, path: tab.reference?.path ?? tab.absPath,
    ...(tab.reference?.relativeTo ? { relativeTo: tab.reference.relativeTo } : {}) }), [workspaceId, tab.reference, tab.absPath]);
  const identity = JSON.stringify(reference);
  const metadata = useResourceRead(`meta:${identity}`, () => clientApi.readFile('', undefined, undefined, { ...reference, metadataOnly: true }), active);
  const metadataPath = metadata.value?.resolvedPath ?? reference.path;
  const kind = detectFileKind(metadataPath);
  const resolved = metadata.value?.ok && metadata.value.metadataOnly && metadata.value.resolvedPath ? { workspaceId, path: metadata.value.resolvedPath } : null;
  const scopedService = !!resolved;
  const readIdentity = JSON.stringify(resolved);
  const content = useResourceRead(`text:${readIdentity}`, () => clientApi.readFile('', undefined, undefined, resolved!), active && scopedService && kind !== 'image' && tab.mode !== 'diff');
  const image = useResourceRead(`image:${readIdentity}`, () => clientApi.readImageDataUrl('', undefined, undefined, resolved!), active && scopedService && kind === 'image' && tab.mode !== 'diff');
  const diff = useResourceRead(`diff:${readIdentity}:${comparison}`, () => clientApi.gitDiff('', undefined, undefined, resolved!, comparison), active && scopedService && tab.mode === 'diff');
  const loaded = content.value;
  const path = tab.mode !== 'diff' && kind !== 'image' && loaded?.ok ? loaded.resolvedPath ?? metadataPath : metadataPath;
  const current = tab.mode === 'diff' ? diff : kind === 'image' ? image : content;
  const reading = useDocumentReadingPosition(`${identity}:${readIdentity}:${path}`, tab.mode === 'diff' ? `diff:${comparison}` : tab.mode,
    active, scopedService && current.value?.ok === true, tab.navigation);
  const busy = metadata.loading || scopedService && current.loading;
  const refreshKey = `${identity}:${readIdentity}:${tab.mode}:${comparison}`;
  const latestRefresh = useRef(refreshKey); latestRefresh.current = refreshKey;
  const nested = useMemo(() => ({ label: isZh ? '打开文档' : 'Open document',
    open: (value: string) => workspace?.openReference({ workspaceId, path: value, ...(loaded?.resolvedPath ? { relativeTo: loaded.resolvedPath } : resolved ? { relativeTo: resolved.path } : {}) }),
    openUrl: (value: string) => workspace?.openUrl(value),
    remoteImages: 'link' as const,
    remoteImageLabel: isZh ? '打开外部图片' : 'Open external image',
  }), [workspace, workspaceId, loaded?.resolvedPath, resolved?.path, isZh]);
  const refresh = async () => {
    const previous = metadata.snapshot().value?.resolvedPath;
    if (!await metadata.reload() || !live.current || latestRefresh.current !== refreshKey) return;
    const next = metadata.snapshot().value;
    if (!next?.ok || !next.metadataOnly || !next.resolvedPath || next.resolvedPath !== previous) return;
    await current.reload();
  };
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
    <div ref={reading.ref} onScroll={reading.onScroll} className="resource-document-body" aria-busy={busy}>
      {!metadata.loaded && !metadata.error ? <p role="status">{isZh ? '正在核对并读取文档…' : 'Resolving document…'}</p>
        : !metadata.value?.ok ? <>
          <p role="alert">{documentReadError(metadata.value?.status, isZh)}</p>
          {metadata.value?.candidates?.map(candidate => <button type="button" className="resource-candidate" key={candidate.path}
            onClick={() => workspace?.openReference({ workspaceId, path: candidate.path })}>{candidate.path}</button>)}
        </> : !scopedService ? <p role="alert">{isZh ? '无法确认文档来源，请在本机资源服务更新生效后重试。' : 'The document source could not be confirmed. Retry after the local resource service update takes effect.'}</p> : tab.mode === 'diff' ? <>
          <select value={comparison} aria-label={isZh ? '比较基准' : 'Comparison base'} onChange={event => setComparison(event.target.value as 'working' | 'staged')}>
            <option value="working">{isZh ? '暂存区 → 工作树' : 'Index → working tree'}</option>
            <option value="staged">{isZh ? 'HEAD → 暂存区' : 'HEAD → index'}</option>
          </select>
          {diff.value?.ok ? diff.value.diffText ? <DiffViewer diffText={diff.value.diffText} showFileIndex={false} isZh={isZh} />
              : <p>{isZh ? '当前比较范围没有改动。' : 'No changes in this comparison.'}</p>
              : <p role={!diff.loaded && !diff.error ? 'status' : 'alert'}>{!diff.loaded && !diff.error ? (isZh ? '正在读取 Diff…' : 'Reading Diff…') : documentReadError(diff.value?.status, isZh)}</p>}
        </> : kind === 'image' ? image.value?.ok ? <img className="resource-image" src={image.value.dataUrl} onLoad={reading.restore} alt={path.split(/[\\/]/).pop() ?? ''} />
          : <p>{!image.loaded && !image.error ? (isZh ? '正在读取图片…' : 'Reading image…') : documentReadError(image.value?.status, isZh)}</p>
          : loaded?.ok ? <DocumentPreviewContext.Provider value={nested}>
            {detectFileKind(path) === 'markdown' && tab.mode === 'preview'
              ? <MarkdownDocument content={loaded.content} emptyLabel={isZh ? '文档为空。' : 'The document is empty.'} copyLabel={isZh ? '复制' : 'Copy'} copiedLabel={isZh ? '已复制' : 'Copied'} />
              : <SourceViewer content={loaded.content} language={highlightLanguageForPath(path)} emptyLabel={isZh ? '文件为空。' : 'The file is empty.'} />}
          </DocumentPreviewContext.Provider>
            : <p role={!content.loaded && !content.error ? 'status' : 'alert'}>{!content.loaded && !content.error ? (isZh ? '正在读取正文…' : 'Reading content…') : documentReadError(loaded?.status, isZh)}</p>}
      {current.value?.ok && tab.mode === 'source' && reading.missingLine ? <p role="status">{isZh ? '引用的行号超出当前文件范围，已保留正常阅读位置。' : 'The referenced line is outside the current file. The reading position is preserved.'}</p> : null}
      {metadata.error || current.error ? <p role="alert">{isZh ? '刷新未确认，上次内容可能已过期。可重试。' : 'Refresh was not confirmed. Previous content may be stale. Retry.'}</p> : null}
    </div>
  </section>;
}
