import { useWorkbench } from './WorkbenchContext';

interface WorkbenchToggleProps {
  readonly isZh: boolean;
}

export function WorkbenchToggle({ isZh }: WorkbenchToggleProps) {
  const { open, toggleOpen } = useWorkbench();
  const label = open
    ? isZh ? '隐藏工作台' : 'Hide workbench'
    : isZh ? '显示工作台' : 'Show workbench';
  return (
    <button
      type="button"
      className={`workbench-toggle${open ? ' workbench-toggle--active' : ''}`}
      aria-pressed={open}
      aria-label={label}
      title={`${label} (⌘\\)`}
      onClick={toggleOpen}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
        <path d={open ? 'M18 9v6' : 'M18 9v6'} opacity={open ? 1 : 0.5} />
      </svg>
    </button>
  );
}
