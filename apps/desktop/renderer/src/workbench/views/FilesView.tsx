interface FilesViewProps {
  readonly isZh: boolean;
  readonly workspacePath: string | null;
}

export function FilesView({ isZh, workspacePath }: FilesViewProps) {
  return (
    <div className="workbench-empty">
      <div className="workbench-empty-title">{isZh ? '文件' : 'Files'}</div>
      <p className="workbench-empty-hint">
        {isZh
          ? `跟随当前会话工作目录的文件树。占位骨架，实现待排期。`
          : `File tree rooted at the current session’s cwd. Skeleton placeholder.`}
      </p>
      {workspacePath ? (
        <div className="workbench-empty-meta" title={workspacePath}>
          {workspacePath}
        </div>
      ) : null}
    </div>
  );
}
