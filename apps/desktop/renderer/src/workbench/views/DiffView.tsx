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
      const result = await clientApi.gitDiff(diffTarget.absPath, diffTarget.workspaceRoot);
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

  const lines = useMemo(() => {
    const text = state.result?.diffText ?? '';
    if (!text) return [] as { kind: LineKind; text: string }[];
    return text.replace(/\n$/, '').split('\n').map((text) => ({ kind: classifyLine(text), text }));
  }, [state.result]);

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
              <div>
                {isZh
                  ? '该文件不在 git 仓库中，无法显示 diff。'
                  : 'This file is not inside a git repository.'}
              </div>
            ) : result.status === 'not_found' ? (
              <div>{isZh ? '文件不存在。' : 'File not found.'}</div>
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
                  {line.text === '' ? '\u00a0' : line.text}
                  {'\n'}
                </span>
              ))}
            </code>
          </pre>
        )}
      </div>
    </div>
  );
}
