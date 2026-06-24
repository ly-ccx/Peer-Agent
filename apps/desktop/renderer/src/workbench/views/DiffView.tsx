import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';
import { useWorkbench } from '../WorkbenchContext';

interface DiffViewProps {
  readonly isZh: boolean;
}

type GitDiffResult = Awaited<ReturnType<typeof clientApi.gitDiff>>;
type DiffStatus = GitDiffResult['status'];

interface LoadState {
  readonly loading: boolean;
  readonly result: GitDiffResult | null;
  readonly error: string | null;
}

const INITIAL: LoadState = { loading: false, result: null, error: null };

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

export function DiffView({ isZh }: DiffViewProps) {
  const { diffTarget } = useWorkbench();
  const [state, setState] = useState<LoadState>(INITIAL);

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

  useEffect(() => {
    void load();
  }, [load]);

  const lines = useMemo(() => buildDiffLines(state.result?.diffText ?? ''), [state.result]);

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

  return (
    <div className="workbench-diff">
      <div className="workbench-diff-header">
        <div className="workbench-diff-titles">
          <span className="workbench-diff-filename" title={diffTarget.absPath}>
            {fileName}
          </span>
          {result && result.ok && statusLabel(result.status, isZh) ? (
            <span className="workbench-diff-badge">{statusLabel(result.status, isZh)}</span>
          ) : null}
        </div>
        <div className="workbench-diff-actions">
          <button
            type="button"
            className="workbench-diff-btn"
            onClick={() => void load()}
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
      </div>
    </div>
  );
}
