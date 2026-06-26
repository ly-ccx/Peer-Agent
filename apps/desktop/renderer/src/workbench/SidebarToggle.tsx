import { useWorkbench } from './WorkbenchContext';

interface SidebarToggleProps {
  readonly isZh: boolean;
}

/**
 * 左侧栏展开/收起按钮，挂在 ChatHeader 的 .chat-header-left 最左，
 * 与右侧 WorkbenchToggle 视觉对称、常驻显示，图标随收起态变化。
 * 快捷键 ⌘B（在 WorkbenchContext 中注册）。
 *
 * 见 peer-knowledge: design/product/left-sidebar-resizable-collapsible.md
 */
export function SidebarToggle({ isZh }: SidebarToggleProps) {
  const { sidebarCollapsed, toggleSidebar } = useWorkbench();
  const expanded = !sidebarCollapsed;
  const label = expanded
    ? isZh ? '隐藏侧边栏' : 'Hide sidebar'
    : isZh ? '显示侧边栏' : 'Show sidebar';
  return (
    <button
      type="button"
      className={`sidebar-toggle${expanded ? ' sidebar-toggle--active' : ''}`}
      aria-pressed={expanded}
      aria-label={label}
      title={`${label} (⌘B)`}
      onClick={toggleSidebar}
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
        {/* 左栏分隔线在左侧，与右侧 WorkbenchToggle 镜像 */}
        <path d="M9 4v16" />
        <path d="M6 9v6" opacity={expanded ? 1 : 0.5} />
      </svg>
    </button>
  );
}
