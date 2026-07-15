import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';
import { DiffViewer } from '../file-preview/DiffViewer';
import {
  basename,
  detectFileKind,
  formatJsonForPreview,
  type WorkbenchFileKind,
} from '../file-preview/fileTypes';
import { MarkdownDocument } from '../file-preview/MarkdownDocument';
import { SourceViewer } from '../file-preview/SourceViewer';
import { ResourceTabStrip } from '../ResourceTabStrip';
import {
  activateDocumentTab,
  closeDocumentTab,
  updateDocumentTabMode,
  type DocumentSessionState,
  type DocumentTabSession,
  type WorkbenchFileMode,
} from '../documentSessionState';

interface DocumentViewProps {
  readonly isZh: boolean;
  readonly session: DocumentSessionState;
  readonly onSessionChange: (
    next: DocumentSessionState | ((current: DocumentSessionState) => DocumentSessionState),
  ) => void;
  readonly onBrowseFiles: () => void;
}

interface DocumentPageProps {
  readonly isZh: boolean;
  readonly tab: DocumentTabSession;
  readonly active: boolean;
  readonly onModeChange: (tabId: string, mode: WorkbenchFileMode) => void;
}

type GitDiffResult = Awaited<ReturnType<typeof clientApi.gitDiff>>;
type DiffStatus = GitDiffResult['status'];
type FileReadResult = Awaited<ReturnType<typeof clientApi.readFile>>;

interface DiffState {
  readonly loading: boolean;
  readonly result: GitDiffResult | null;
  readonly error: string | null;
}

interface ContentState {
  readonly loading: boolean;
  readonly result: FileReadResult | null;
  readonly error: string | null;
}

const INITIAL_DIFF: DiffState = { loading: false, result: null, error: null };
const INITIAL_CONTENT: ContentState = { loading: false, result: null, error: null };

function statusLabel(status: DiffStatus, isZh: boolean): string {
  switch (status) {
    case 'modified':
      return isZh ? '工作区改动' : 'Working tree changes';
    case 'staged':
      return isZh ? '已暂存改动' : 'Staged changes';
    case 'last_commit':
      return isZh ? '最近一次提交' : 'Last commit';
    case 'untracked':
      return isZh ? '未跟踪（新文件）' : 'Untracked (new file)';
    default:
      return '';
  }
}

function contentErrorLabel(status: FileReadResult['status'], size: number | undefined, isZh: boolean): string {
  switch (status) {
    case 'not_found':
      return isZh ? '文件不存在或无权访问。' : 'File not found or not accessible.';
    case 'not_file':
      return isZh ? '该路径不是文件（可能是目录）。' : 'This path is not a file (it may be a directory).';
    case 'too_large': {
      const mb = typeof size === 'number' ? (size / (1024 * 1024)).toFixed(1) : '';
      return isZh
        ? `文件过大${mb ? `（${mb} MB）` : ''}，无法预览，请在编辑器中打开。`
        : `File too large${mb ? ` (${mb} MB)` : ''} to preview. Open it in the editor instead.`;
    }
    case 'binary':
      return isZh ? '这是二进制文件，无法预览内容。' : 'This is a binary file and cannot be previewed.';
    case 'invalid_path':
      return isZh ? '文件路径无效。' : 'Invalid file path.';
    default:
      return isZh ? '无法读取文件内容。' : 'Unable to read file content.';
  }
}

function modeBadge(mode: WorkbenchFileMode, kind: WorkbenchFileKind, isZh: boolean): string {
  if (mode === 'diff') return '';
  if (mode === 'source') return isZh ? '源码' : 'Source';
  switch (kind) {
    case 'markdown':
      return 'Markdown';
    case 'json':
      return 'JSON';
    case 'image':
      return isZh ? '图片' : 'Image';
    default:
      return isZh ? '预览' : 'Preview';
  }
}

const RESOURCE_ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function DocumentIcon() {
  return (
    <svg {...RESOURCE_ICON_PROPS}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function AddIcon() {
  return <svg {...RESOURCE_ICON_PROPS}><path d="M12 5v14M5 12h14" /></svg>;
}

export function DocumentView({
  isZh,
  session,
  onSessionChange,
  onBrowseFiles,
}: DocumentViewProps) {
  const selectTab = useCallback((tabId: string) => {
    onSessionChange((current) => activateDocumentTab(current, tabId));
  }, [onSessionChange]);

  const removeTab = useCallback((tabId: string) => {
    onSessionChange((current) => closeDocumentTab(current, tabId));
  }, [onSessionChange]);

  const changeMode = useCallback((tabId: string, mode: WorkbenchFileMode) => {
    onSessionChange((current) => updateDocumentTabMode(current, tabId, mode));
  }, [onSessionChange]);

  const items = useMemo(() => session.tabs.map((tab) => ({
    id: tab.id,
    label: basename(tab.absPath),
    icon: <DocumentIcon />,
  })), [session.tabs]);

  return (
    <div className="document-view">
      <ResourceTabStrip
        ariaLabel={isZh ? '文档标签' : 'Document tabs'}
        items={items}
        activeId={session.activeTabId}
        closeLabel={isZh ? '关闭文档' : 'Close document'}
        onActivate={selectTab}
        onClose={removeTab}
        action={{
          label: isZh ? '打开文件' : 'Open file',
          icon: <AddIcon />,
          onClick: onBrowseFiles,
        }}
      />
      <div className="document-stage">
        {session.tabs.length === 0 ? (
          <div className="workbench-empty">
            <div className="workbench-empty-title">{isZh ? '文档' : 'Documents'}</div>
            <p className="workbench-empty-hint">
              {isZh
                ? '从文件树选择文件，或点击聊天消息中的文件路径。'
                : 'Select a file from the tree, or click a file path in chat.'}
            </p>
            <button type="button" className="workbench-diff-btn" onClick={onBrowseFiles}>
              {isZh ? '浏览文件' : 'Browse files'}
            </button>
          </div>
        ) : session.tabs.map((tab) => (
          <DocumentPage
            key={tab.id}
            isZh={isZh}
            tab={tab}
            active={tab.id === session.activeTabId}
            onModeChange={changeMode}
          />
        ))}
      </div>
    </div>
  );
}

function DocumentPage({ isZh, tab: fileTarget, active, onModeChange }: DocumentPageProps) {
  const mode = fileTarget.mode;
  const [diff, setDiff] = useState<DiffState>(INITIAL_DIFF);
  const [content, setContent] = useState<ContentState>(INITIAL_CONTENT);

  const kind = useMemo(
    () => detectFileKind(fileTarget.absPath),
    [fileTarget.absPath],
  );

  useEffect(() => {
    setDiff(INITIAL_DIFF);
    setContent(INITIAL_CONTENT);
  }, [fileTarget.absPath, fileTarget.relPath, fileTarget.workspaceRoot]);

  const loadDiff = useCallback(async () => {
    setDiff({ loading: true, result: null, error: null });
    try {
      const result = await clientApi.gitDiff(fileTarget.absPath, fileTarget.workspaceRoot, fileTarget.relPath);
      setDiff({ loading: false, result, error: null });
    } catch (err) {
      setDiff({
        loading: false,
        result: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [fileTarget.absPath, fileTarget.relPath, fileTarget.workspaceRoot]);

  const loadContent = useCallback(async () => {
    setContent({ loading: true, result: null, error: null });
    try {
      const result = await clientApi.readFile(fileTarget.absPath, fileTarget.workspaceRoot, fileTarget.relPath);
      setContent({ loading: false, result, error: null });
    } catch (err) {
      setContent({
        loading: false,
        result: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [fileTarget.absPath, fileTarget.relPath, fileTarget.workspaceRoot]);

  useEffect(() => {
    if (!active || mode !== 'diff' || diff.loading || diff.result || diff.error) return;
    void loadDiff();
  }, [active, mode, diff.loading, diff.result, diff.error, loadDiff]);

  useEffect(() => {
    if (!active || mode === 'diff' || content.loading || content.result || content.error) return;
    void loadContent();
  }, [active, mode, content.loading, content.result, content.error, loadContent]);

  const fileName = basename(fileTarget.absPath);
  const statusBadge = mode === 'diff'
    ? (diff.result?.ok ? statusLabel(diff.result.status, isZh) : '')
    : modeBadge(mode, kind, isZh);

  const openInEditor = () => {
    void clientApi.openPath(fileTarget.absPath, fileTarget.workspaceRoot);
  };

  const refresh = () => {
    if (mode === 'diff') {
      void loadDiff();
      return;
    }
    void loadContent();
  };

  const renderContentError = (result: FileReadResult) => (
    <div className="workbench-empty-hint workbench-diff-status">
      <div>{contentErrorLabel(result.status, result.size, isZh)}</div>
      <div className="workbench-diff-path">{fileTarget.absPath}</div>
      {result.status === 'too_large' || result.status === 'binary' ? (
        <button type="button" className="workbench-diff-btn" onClick={openInEditor}>
          {isZh ? '在编辑器中打开' : 'Open in editor'}
        </button>
      ) : null}
    </div>
  );

  const renderSource = () => {
    if (content.loading) {
      return (
        <div className="workbench-empty-hint workbench-diff-status">
          {isZh ? '正在加载文件内容…' : 'Loading file content…'}
        </div>
      );
    }
    if (content.error) {
      return (
        <div className="workbench-empty-hint workbench-diff-status">
          {isZh ? `加载失败：${content.error}` : `Failed to load: ${content.error}`}
        </div>
      );
    }
    if (!content.result) return null;
    if (!content.result.ok) return renderContentError(content.result);
    return (
      <>
        {content.result.resolvedFrom ? (
          <div className="workbench-diff-resolved">
            {isZh
              ? `已在其他仓库找到该文件：${content.result.resolvedFrom}`
              : `Found this file in another repository: ${content.result.resolvedFrom}`}
          </div>
        ) : null}
        <SourceViewer
          content={content.result.content}
          emptyLabel={isZh ? '（空文件）' : '(Empty file)'}
        />
      </>
    );
  };

  const renderPreview = () => {
    if (content.loading) {
      return (
        <div className="workbench-empty-hint workbench-diff-status">
          {isZh ? '正在加载文件内容…' : 'Loading file content…'}
        </div>
      );
    }
    if (content.error) {
      return (
        <div className="workbench-empty-hint workbench-diff-status">
          {isZh ? `加载失败：${content.error}` : `Failed to load: ${content.error}`}
        </div>
      );
    }
    if (!content.result) return null;
    if (!content.result.ok) return renderContentError(content.result);

    const resolved = content.result.resolvedFrom ? (
      <div className="workbench-diff-resolved">
        {isZh
          ? `已在其他仓库找到该文件：${content.result.resolvedFrom}`
          : `Found this file in another repository: ${content.result.resolvedFrom}`}
      </div>
    ) : null;

    if (kind === 'markdown') {
      return (
        <>
          {resolved}
          <MarkdownDocument
            content={content.result.content}
            emptyLabel={isZh ? '（空文件）' : '(Empty file)'}
            copyLabel={isZh ? '复制' : 'Copy'}
            copiedLabel={isZh ? '已复制' : 'Copied'}
          />
        </>
      );
    }

    if (kind === 'json') {
      const formatted = formatJsonForPreview(content.result.content);
      return (
        <>
          {resolved}
          <SourceViewer
            className="workbench-json-preview"
            content={formatted ?? content.result.content}
            emptyLabel={isZh ? '（空文件）' : '(Empty file)'}
          />
          {!formatted && content.result.content !== '' ? (
            <div className="workbench-diff-hint workbench-file-preview-hint">
              {isZh ? 'JSON 解析失败，已按源码显示。' : 'JSON parsing failed; showing source text.'}
            </div>
          ) : null}
        </>
      );
    }

    return (
      <>
        {resolved}
        <SourceViewer
          content={content.result.content}
          emptyLabel={isZh ? '（空文件）' : '(Empty file)'}
        />
      </>
    );
  };

  const renderDiff = () => {
    const result = diff.result;
    if (result?.ok && result.resolvedFrom) {
      return (
        <>
          <div className="workbench-diff-resolved">
            {isZh
              ? `已在其他仓库找到该文件：${result.resolvedFrom}`
              : `Found this file in another repository: ${result.resolvedFrom}`}
          </div>
          {renderDiffBody(result)}
        </>
      );
    }
    return renderDiffBody(result);
  };

  const renderDiffBody = (result: GitDiffResult | null) => {
    if (diff.loading) {
      return (
        <div className="workbench-empty-hint workbench-diff-status">
          {isZh ? '正在加载 diff…' : 'Loading diff…'}
        </div>
      );
    }
    if (diff.error) {
      return (
        <div className="workbench-empty-hint workbench-diff-status">
          {isZh ? `加载失败：${diff.error}` : `Failed to load: ${diff.error}`}
        </div>
      );
    }
    if (!result) return null;
    if (!result.ok) {
      return (
        <div className="workbench-empty-hint workbench-diff-status">
          {result.status === 'not_git_repo' ? (
            <>
              <div>
                {isZh
                  ? '该文件不在 git 仓库中，无法显示 diff。'
                  : 'This file is not inside a git repository.'}
              </div>
              <div className="workbench-diff-path">{fileTarget.absPath}</div>
            </>
          ) : result.status === 'not_found' ? (
            <>
              <div>{isZh ? '文件不存在。' : 'File not found.'}</div>
              <div className="workbench-diff-path">{fileTarget.absPath}</div>
              {fileTarget.relPath ? (
                <div className="workbench-diff-hint">
                  {isZh
                    ? '可能是跨仓库的相对路径：上面的绝对路径是按当前会话工作区解析出来的，但该文件可能在另一个仓库里。请确认会话工作区是否与文件所属仓库一致，或在引用时使用绝对路径。'
                    : 'This may be a cross-repository relative path: the absolute path above was resolved against the current conversation workspace, but the file may live in another repository. Check that the workspace matches, or use an absolute path.'}
                </div>
              ) : null}
            </>
          ) : (
            <div>
              {isZh
                ? `无法获取 diff：${result.error ?? result.status}`
                : `Unable to get diff: ${result.error ?? result.status}`}
            </div>
          )}
        </div>
      );
    }
    if (result.status === 'no_changes' || !result.diffText.trim()) {
      return (
        <div className="workbench-empty-hint workbench-diff-status">
          {isZh ? '该文件没有未提交的改动。' : 'No uncommitted changes for this file.'}
        </div>
      );
    }
    return <DiffViewer diffText={result.diffText} />;
  };

  return (
    <div
      className="document-page workbench-diff workbench-file-preview"
      data-active={active}
      aria-hidden={!active}
    >
      <div className="workbench-diff-header">
        <div className="workbench-diff-titles">
          <span className="workbench-diff-filename" title={fileTarget.absPath}>
            {fileName}
          </span>
          {statusBadge ? <span className="workbench-diff-badge">{statusBadge}</span> : null}
        </div>
        <div className="workbench-diff-actions">
          <div
            className="workbench-diff-segmented"
            role="tablist"
            aria-label={isZh ? '查看模式' : 'View mode'}
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'preview'}
              className={`workbench-diff-segment${mode === 'preview' ? ' is-active' : ''}`}
              onClick={() => onModeChange(fileTarget.id, 'preview')}
            >
              {isZh ? '预览' : 'Preview'}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'source'}
              className={`workbench-diff-segment${mode === 'source' ? ' is-active' : ''}`}
              onClick={() => onModeChange(fileTarget.id, 'source')}
            >
              {isZh ? '源码' : 'Source'}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'diff'}
              className={`workbench-diff-segment${mode === 'diff' ? ' is-active' : ''}`}
              onClick={() => onModeChange(fileTarget.id, 'diff')}
            >
              Diff
            </button>
          </div>
          <button
            type="button"
            className="workbench-diff-btn"
            onClick={refresh}
            title={isZh ? '刷新' : 'Refresh'}
          >
            {isZh ? '刷新' : 'Refresh'}
          </button>
          <button
            type="button"
            className="workbench-diff-btn"
            onClick={openInEditor}
            title={isZh ? '在编辑器中打开' : 'Open in editor'}
          >
            {isZh ? '在编辑器中打开' : 'Open in editor'}
          </button>
        </div>
      </div>

      <div className="workbench-diff-body">
        {mode === 'diff' ? renderDiff() : mode === 'source' ? renderSource() : renderPreview()}
      </div>
    </div>
  );
}
