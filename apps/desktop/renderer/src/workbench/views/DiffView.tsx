import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';
import { useWorkbench } from '../WorkbenchContext';

interface DiffViewProps {
  readonly isZh: boolean;
}

type GitDiffResult = Awaited<ReturnType<typeof clientApi.gitDiff>>;
type DiffStatus = GitDiffResult['status'];

type FileReadResult = Awaited<ReturnType<typeof clientApi.readFile>>;

// Diff 视图的两种展示模式：git diff（默认）或文件完整内容。
type ViewMode = 'diff' | 'content';

interface LoadState {
  readonly loading: boolean;
  readonly result: GitDiffResult | null;
  readonly error: string | null;
}

interface ContentState {
  readonly loading: boolean;
  readonly result: FileReadResult | null;
  readonly error: string | null;
}

const INITIAL: LoadState = { loading: false, result: null, error: null };
const CONTENT_INITIAL: ContentState = { loading: false, result: null, error: null };

function basename(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

// 单个渲染行：除内容/类型外，携带双列行号（旧文件号 / 新文件号）。
// 删除行只有 oldNo，新增行只有 newNo，上下文行两者都有，hunk/meta 行均无。
interface DiffLine {
  readonly kind: LineKind;
  readonly text: string;
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

// 解析 hunk 头 "@@ -oldStart,oldCount +newStart,newCount @@" 的起始行号。
// 返回 [oldStart, newStart]；解析失败返回 null。
function parseHunkHeader(line: string): readonly [number, number] | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

// 把 unified diff 文本逐行解析为带双列行号的 DiffLine[]。
// 通过跟踪当前 hunk 的旧/新游标，对 ctx/add/del 行分别推进对应游标。
function buildDiffLines(text: string): DiffLine[] {
  if (!text) return [];
  const out: DiffLine[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  for (const raw of text.replace(/\n$/, '').split('\n')) {
    const kind = classifyLine(raw);
    if (kind === 'hunk') {
      const parsed = parseHunkHeader(raw);
      if (parsed) {
        oldCursor = parsed[0];
        newCursor = parsed[1];
      }
      out.push({ kind, text: raw, oldNo: null, newNo: null });
      continue;
    }
    if (kind === 'meta') {
      out.push({ kind, text: raw, oldNo: null, newNo: null });
      continue;
    }
    // add/del/ctx 行：剥掉 git 的首字符标记（+/-/空格），
    // 让内容列只放纯代码；增删的视觉区分交给配色（color 模式）
    // 或 CSS ::before 注入的 +/- 符号（sign 模式）。
    const body = raw.slice(1);
    if (kind === 'add') {
      out.push({ kind, text: body, oldNo: null, newNo: newCursor });
      newCursor += 1;
      continue;
    }
    if (kind === 'del') {
      out.push({ kind, text: body, oldNo: oldCursor, newNo: null });
      oldCursor += 1;
      continue;
    }
    // ctx：旧/新都推进
    out.push({ kind, text: body, oldNo: oldCursor, newNo: newCursor });
    oldCursor += 1;
    newCursor += 1;
  }
  return out;
}

function classifyLine(line: string): LineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('similarity ') ||
    line.startsWith('rename ') ||
    line.startsWith('Binary ')
  ) {
    return 'meta';
  }
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

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

// 「文件内容」模式下，把后端返回的失败 status 翻译成用户可读的友好文案。
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

export function DiffView({ isZh }: DiffViewProps) {
  const { diffTarget } = useWorkbench();
  const [state, setState] = useState<LoadState>(INITIAL);
  const [mode, setMode] = useState<ViewMode>('diff');
  const [content, setContent] = useState<ContentState>(CONTENT_INITIAL);

  const load = useCallback(async () => {
    if (!diffTarget) {
      setState(INITIAL);
      return;
    }
    setState({ loading: true, result: null, error: null });
    try {
      const result = await clientApi.gitDiff(diffTarget.absPath, diffTarget.workspaceRoot, diffTarget.relPath);
      setState({ loading: false, result, error: null });
    } catch (err) {
      setState({
        loading: false,
        result: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [diffTarget]);

  const loadContent = useCallback(async () => {
    if (!diffTarget) {
      setContent(CONTENT_INITIAL);
      return;
    }
    setContent({ loading: true, result: null, error: null });
    try {
      const result = await clientApi.readFile(diffTarget.absPath, diffTarget.workspaceRoot, diffTarget.relPath);
      setContent({ loading: false, result, error: null });
    } catch (err) {
      setContent({
        loading: false,
        result: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [diffTarget]);

  // 切换 diffTarget 时重置回 diff 模式，避免沿用上一个文件的内容态。
  useEffect(() => {
    setMode('diff');
    setContent(CONTENT_INITIAL);
  }, [diffTarget]);

  useEffect(() => {
    void load();
  }, [load]);

  // 仅在进入「文件内容」模式且尚未加载时按需读取文件，避免无谓 IPC。
  useEffect(() => {
    if (mode === 'content' && diffTarget && !content.loading && content.result === null && content.error === null) {
      void loadContent();
    }
  }, [mode, diffTarget, content.loading, content.result, content.error, loadContent]);

  const lines = useMemo(() => buildDiffLines(state.result?.diffText ?? ''), [state.result]);
  const contentLines = useMemo(
    () => (content.result?.ok ? content.result.content.split('\n') : []),
    [content.result],
  );

  if (!diffTarget) {
    return (
      <div className="workbench-empty">
        <div className="workbench-empty-title">{isZh ? 'Diff' : 'Diff'}</div>
        <p className="workbench-empty-hint">
          {isZh
            ? '点击聊天消息中的文件路径，这里会显示该文件的 git diff。'
            : 'Click a file path in a chat message to see its git diff here.'}
        </p>
      </div>
    );
  }

  const fileName = basename(diffTarget.absPath);
  const result = state.result;

  const openInEditor = () => {
    void clientApi.openPath(diffTarget.absPath, diffTarget.workspaceRoot);
  };

  const refresh = () => {
    if (mode === 'content') {
      void loadContent();
    } else {
      void load();
    }
  };

  return (
    <div className="workbench-diff">
      <div className="workbench-diff-header">
        <div className="workbench-diff-titles">
          <span className="workbench-diff-filename" title={diffTarget.absPath}>
            {fileName}
          </span>
          {mode === 'diff' && result && result.ok && statusLabel(result.status, isZh) ? (
            <span className="workbench-diff-badge">{statusLabel(result.status, isZh)}</span>
          ) : null}
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
              aria-selected={mode === 'diff'}
              className={`workbench-diff-segment${mode === 'diff' ? ' is-active' : ''}`}
              onClick={() => setMode('diff')}
            >
              Diff
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'content'}
              className={`workbench-diff-segment${mode === 'content' ? ' is-active' : ''}`}
              onClick={() => setMode('content')}
            >
              {isZh ? '文件内容' : 'File'}
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
        {mode === 'content' ? (
          content.loading ? (
            <div className="workbench-empty-hint workbench-diff-status">
              {isZh ? '正在加载文件内容…' : 'Loading file content…'}
            </div>
          ) : content.error ? (
            <div className="workbench-empty-hint workbench-diff-status">
              {isZh ? `加载失败：${content.error}` : `Failed to load: ${content.error}`}
            </div>
          ) : !content.result ? null : !content.result.ok ? (
            <div className="workbench-empty-hint workbench-diff-status">
              <div>{contentErrorLabel(content.result.status, content.result.size, isZh)}</div>
              <div className="workbench-diff-path">{diffTarget.absPath}</div>
              {content.result.status === 'too_large' || content.result.status === 'binary' ? (
                <button type="button" className="workbench-diff-btn" onClick={openInEditor}>
                  {isZh ? '在编辑器中打开' : 'Open in editor'}
                </button>
              ) : null}
            </div>
          ) : (
            <>
              {content.result.resolvedFrom ? (
                <div className="workbench-diff-resolved">
                  {isZh
                    ? `已在其他仓库找到该文件：${content.result.resolvedFrom}`
                    : `Found this file in another repository: ${content.result.resolvedFrom}`}
                </div>
              ) : null}
              {content.result.content === '' ? (
                <div className="workbench-empty-hint workbench-diff-status">
                  {isZh ? '（空文件）' : '(Empty file)'}
                </div>
              ) : (
                <pre className="workbench-content-pre">
                  <code>
                    {contentLines.map((text, i) => (
                      <span key={i} className="content-line">
                        <span className="content-gutter" aria-hidden="true">
                          {i + 1}
                        </span>
                        <span className="content-line-text">{text === '' ? '\u00a0' : text}</span>
                      </span>
                    ))}
                  </code>
                </pre>
              )}
            </>
          )
        ) : (
          <>
        {result && result.ok && result.resolvedFrom ? (
          <div className="workbench-diff-resolved">
            {isZh
              ? `已在其他仓库找到该文件：${result.resolvedFrom}`
              : `Found this file in another repository: ${result.resolvedFrom}`}
          </div>
        ) : null}
        {state.loading ? (
          <div className="workbench-empty-hint workbench-diff-status">
            {isZh ? '正在加载 diff…' : 'Loading diff…'}
          </div>
        ) : state.error ? (
          <div className="workbench-empty-hint workbench-diff-status">
            {isZh ? `加载失败：${state.error}` : `Failed to load: ${state.error}`}
          </div>
        ) : !result ? null : !result.ok ? (
          <div className="workbench-empty-hint workbench-diff-status">
            {result.status === 'not_git_repo' ? (
              <>
                <div>
                  {isZh
                    ? '该文件不在 git 仓库中，无法显示 diff。'
                    : 'This file is not inside a git repository.'}
                </div>
                <div className="workbench-diff-path">{diffTarget.absPath}</div>
              </>
            ) : result.status === 'not_found' ? (
              <>
                <div>{isZh ? '文件不存在。' : 'File not found.'}</div>
                <div className="workbench-diff-path">{diffTarget.absPath}</div>
                {diffTarget.relPath ? (
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
        ) : result.status === 'no_changes' || !result.diffText.trim() ? (
          <div className="workbench-empty-hint workbench-diff-status">
            {isZh ? '该文件没有未提交的改动。' : 'No uncommitted changes for this file.'}
          </div>
        ) : (
          <pre className="workbench-diff-pre">
            <code>
              {lines.map((line, i) => (
                <span key={i} className={`diff-line diff-line--${line.kind}`}>
                  <span className="diff-gutter diff-gutter--old" aria-hidden="true">
                    {line.oldNo ?? ''}
                  </span>
                  <span className="diff-gutter diff-gutter--new" aria-hidden="true">
                    {line.newNo ?? ''}
                  </span>
                  <span className="diff-line-text">
                    {line.text === '' ? '\u00a0' : line.text}
                  </span>
                </span>
              ))}
            </code>
          </pre>
        )}
          </>
        )}
      </div>
    </div>
  );
}
