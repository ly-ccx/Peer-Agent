interface BrowserViewProps {
  readonly isZh: boolean;
}

export function BrowserView({ isZh }: BrowserViewProps) {
  return (
    <div className="workbench-empty">
      <div className="workbench-empty-title">{isZh ? '浏览器' : 'Browser'}</div>
      <p className="workbench-empty-hint">
        {isZh
          ? '内嵌浏览器视图，默认空白页。占位骨架，实现待排期。'
          : 'Embedded browser view. Defaults to blank page. Skeleton placeholder.'}
      </p>
    </div>
  );
}
