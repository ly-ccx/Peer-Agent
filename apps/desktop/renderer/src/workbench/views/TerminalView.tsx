interface TerminalViewProps {
  readonly isZh: boolean;
}

export function TerminalView({ isZh }: TerminalViewProps) {
  return (
    <div className="workbench-empty">
      <div className="workbench-empty-title">{isZh ? '终端' : 'Terminal'}</div>
      <p className="workbench-empty-hint">
        {isZh
          ? '此处将聚合本会话所有 Bash 工具调用的输出。占位骨架，实现待排期。'
          : 'Aggregated stdout/stderr from this session’s Bash tool calls. Skeleton placeholder.'}
      </p>
    </div>
  );
}
