import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { clientApi } from '../clientApi';

// 历史 'goal' tab 已正名为 'plan'（与对话 plan 模式同口径）。持久化里的旧 'goal'
// 值经 normalizeTab 归一为 'plan'，确保旧设置不丢、不回落到 terminal。
export type WorkbenchTabId = 'plan' | 'terminal' | 'browser' | 'files' | 'diff';

export interface WorkbenchDiffTarget {
  readonly absPath: string;
  readonly workspaceRoot?: string;
  /** 原始相对路径（解析前），用于主进程跨已知 workspace 回退查找。 */
  readonly relPath?: string;
}

export interface WorkbenchFilesTarget {
  /** 要在「文件」视图中展开并高亮定位的目录绝对路径。 */
  readonly absPath: string;
  readonly workspaceRoot?: string;
  /** 原始相对路径（解析前），用于主进程跨已知 workspace 回退查找。 */
  readonly relPath?: string;
  /** 单调递增令牌：即使重复点击同一目录也能触发「文件」视图重新定位。 */
  readonly nonce: number;
}

export const WORKBENCH_DEFAULT_WIDTH = 600;
export const WORKBENCH_MIN_WIDTH = 320;
export const WORKBENCH_MAX_WIDTH = 900;
export const WORKBENCH_MAX_VW_RATIO = 0.55;
export const MAIN_MIN_WIDTH = 480;
/** 主区恢复到该宽度以上时，才把「自动收起」的左栏自动展开回来（滞回，防回弹横跳）。 */
export const MAIN_RESTORE_WIDTH = 520;

// ── 左侧栏尺寸与收起阈值（见 peer-knowledge: left-sidebar-resizable-collapsible.md）──
export const SIDEBAR_DEFAULT_WIDTH = 264;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 400;
/** 拖拽松手时落点 < 该值则自动收起左栏。 */
export const SIDEBAR_COLLAPSE_THRESHOLD = 180;

interface WorkbenchSettingsShape {
  open?: boolean;
  width?: number;
  activeTab?: Record<string, WorkbenchTabId>;
  sidebarOpen?: boolean;
  sidebarWidth?: number;
}

interface WorkbenchState {
  open: boolean;
  width: number;
  activeTab: WorkbenchTabId;
  goalSlot: HTMLElement | null;
  hasGoalPlan: boolean;
  sidebarAutoCollapsed: boolean;
  /** 用户主动开合意图（false=用户主动收起，不被右侧挤压逻辑自动展开）。 */
  sidebarOpen: boolean;
  /** 展开态左栏宽度（px），拖拽松手时落入并持久化。 */
  sidebarWidth: number;
  /** 左栏最终是否收起 = 用户主动收起 或 右侧挤压自动收起。 */
  sidebarCollapsed: boolean;
  diffTarget: WorkbenchDiffTarget | null;
  filesTarget: WorkbenchFilesTarget | null;
}

interface WorkbenchActions {
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setActiveTab: (tab: WorkbenchTabId) => void;
  setWidth: (width: number) => void;
  registerGoalSlot: (el: HTMLElement | null) => void;
  setHasGoalPlan: (has: boolean) => void;
  setSidebarAutoCollapsed: (collapsed: boolean) => void;
  /** 用户主动展开/收起左栏（toggle 按钮、⌘B）。主动操作会清除自动收起标记。 */
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  /** 拖拽松手落定左栏宽度并持久化。 */
  setSidebarWidth: (width: number) => void;
  openDiff: (absPath: string, workspaceRoot?: string, relPath?: string) => void;
  revealInFiles: (absPath: string, workspaceRoot?: string, relPath?: string) => void;
}

type WorkbenchContextValue = WorkbenchState & WorkbenchActions & { conversationId: string | null };

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

function clampWidth(value: number): number {
  const vwLimit =
    typeof window !== 'undefined'
      ? Math.min(WORKBENCH_MAX_WIDTH, Math.floor(window.innerWidth * WORKBENCH_MAX_VW_RATIO))
      : WORKBENCH_MAX_WIDTH;
  const upper = Math.max(WORKBENCH_MIN_WIDTH, vwLimit);
  return Math.min(upper, Math.max(WORKBENCH_MIN_WIDTH, Math.round(value)));
}

function clampSidebarWidth(value: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

function readWorkbenchSettings(raw: unknown): WorkbenchSettingsShape {
  if (!raw || typeof raw !== 'object') return {};
  const wb = (raw as Record<string, unknown>).workbench;
  if (!wb || typeof wb !== 'object') return {};
  return wb as WorkbenchSettingsShape;
}

function isValidTab(value: unknown): value is WorkbenchTabId {
  return (
    value === 'plan' ||
    value === 'terminal' ||
    value === 'browser' ||
    value === 'files' ||
    value === 'diff'
  );
}

/** 把持久化/历史输入归一为当前 tab 值：旧 'goal' 等价于当前 'plan'。 */
function normalizeTab(value: unknown): WorkbenchTabId | null {
  if (value === 'goal') return 'plan';
  return isValidTab(value) ? value : null;
}

/** 对整份 activeTab 持久化映射做归一（旧 'goal' → 'plan'），并丢弃非法值。 */
function normalizeActiveTabMap(
  map: Record<string, WorkbenchTabId> | undefined,
): Record<string, WorkbenchTabId> {
  if (!map || typeof map !== 'object') return {};
  const out: Record<string, WorkbenchTabId> = {};
  for (const [key, raw] of Object.entries(map)) {
    const tab = normalizeTab(raw);
    if (tab) out[key] = tab;
  }
  return out;
}

interface WorkbenchProviderProps {
  readonly conversationId: string | null;
  readonly children: ReactNode;
}

export function WorkbenchProvider({ conversationId, children }: WorkbenchProviderProps) {
  const initial = readWorkbenchSettings(clientApi.initialSettings);
  const [open, setOpenState] = useState<boolean>(initial.open === true);
  const [width, setWidthState] = useState<number>(clampWidth(initial.width ?? WORKBENCH_DEFAULT_WIDTH));
  const [activeTabMap, setActiveTabMap] = useState<Record<string, WorkbenchTabId>>(
    normalizeActiveTabMap(initial.activeTab),
  );
  const [goalSlot, setGoalSlotState] = useState<HTMLElement | null>(null);
  const [hasGoalPlan, setHasGoalPlanState] = useState<boolean>(false);
  const [sidebarAutoCollapsed, setSidebarAutoCollapsedState] = useState<boolean>(false);
  const [sidebarOpen, setSidebarOpenState] = useState<boolean>(initial.sidebarOpen !== false);
  const [sidebarWidth, setSidebarWidthState] = useState<number>(
    clampSidebarWidth(initial.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH),
  );
  // 当前「有效收起」态的最新值（供 toggle/⌘B 在回调中读取，无需把状态加进依赖）。
  const collapsedRef = useRef<boolean>(initial.sidebarOpen === false);
  const [diffTarget, setDiffTarget] = useState<WorkbenchDiffTarget | null>(null);
  const [filesTarget, setFilesTarget] = useState<WorkbenchFilesTarget | null>(null);
  const filesNonceRef = useRef(0);

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef({ open, width, activeTabMap, sidebarOpen, sidebarWidth });
  latestRef.current = { open, width, activeTabMap, sidebarOpen, sidebarWidth };

  const schedulePersist = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const { open: o, width: w, activeTabMap: m, sidebarOpen: so, sidebarWidth: sw } = latestRef.current;
      void clientApi
        .updateSettings({ workbench: { open: o, width: w, activeTab: m, sidebarOpen: so, sidebarWidth: sw } })
        .catch(() => {});
    }, 250);
  }, []);

  useEffect(() => () => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
  }, []);

  const setOpen = useCallback((next: boolean) => {
    setOpenState((prev) => (prev === next ? prev : next));
    schedulePersist();
  }, [schedulePersist]);

  const toggleOpen = useCallback(() => {
    setOpenState((prev) => !prev);
    schedulePersist();
  }, [schedulePersist]);

  const setWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidthState((prev) => (prev === clamped ? prev : clamped));
    schedulePersist();
  }, [schedulePersist]);

  const setActiveTab = useCallback((tab: WorkbenchTabId) => {
    const key = conversationId ?? '__none';
    setActiveTabMap((prev) => {
      if (prev[key] === tab) return prev;
      return { ...prev, [key]: tab };
    });
    schedulePersist();
  }, [conversationId, schedulePersist]);

  const openDiff = useCallback((absPath: string, workspaceRoot?: string, relPath?: string) => {
    setDiffTarget({ absPath, workspaceRoot, relPath });
    const key = conversationId ?? '__none';
    setActiveTabMap((prev) => (prev[key] === 'diff' ? prev : { ...prev, [key]: 'diff' }));
    setOpenState(true);
    schedulePersist();
  }, [conversationId, schedulePersist]);

  const revealInFiles = useCallback((absPath: string, workspaceRoot?: string, relPath?: string) => {
    filesNonceRef.current += 1;
    setFilesTarget({ absPath, workspaceRoot, relPath, nonce: filesNonceRef.current });
    const key = conversationId ?? '__none';
    setActiveTabMap((prev) => (prev[key] === 'files' ? prev : { ...prev, [key]: 'files' }));
    setOpenState(true);
    schedulePersist();
  }, [conversationId, schedulePersist]);

  const registerGoalSlot = useCallback((el: HTMLElement | null) => {
    setGoalSlotState((prev) => (prev === el ? prev : el));
  }, []);

  const setHasGoalPlan = useCallback((has: boolean) => {
    setHasGoalPlanState((prev) => (prev === has ? prev : has));
  }, []);

  const setSidebarAutoCollapsed = useCallback((collapsed: boolean) => {
    setSidebarAutoCollapsedState((prev) => (prev === collapsed ? prev : collapsed));
  }, []);

  // 用户主动展开/收起左栏（toggle 按钮、⌘B）。主动操作清除「自动收起」标记，
  // 让右侧挤压逻辑不再擅自覆盖用户意图。
  const setSidebarOpen = useCallback((next: boolean) => {
    setSidebarOpenState((prev) => (prev === next ? prev : next));
    setSidebarAutoCollapsedState(false);
    schedulePersist();
  }, [schedulePersist]);

  // 切换基于「当前是否有效收起」（来自任意来源）：
  // - 有效收起（用户主动收起 或 右侧挤压自动收起）→ 展开：sidebarOpen=true 且清自动标记
  // - 当前展开 → 主动收起：sidebarOpen=false
  // 这样当左栏因右侧挤压被自动收起时，单击 toggle/⌘B 也能一次展开。
  const toggleSidebar = useCallback(() => {
    const collapsedNow = collapsedRef.current;
    setSidebarOpenState(collapsedNow);
    setSidebarAutoCollapsedState(false);
    schedulePersist();
  }, [schedulePersist]);

  // 拖拽松手落定左栏宽度（已在 Resizer 内做过阈值/收起判定，这里只负责夹紧 + 持久化）。
  const setSidebarWidth = useCallback((next: number) => {
    const clamped = clampSidebarWidth(next);
    setSidebarWidthState((prev) => (prev === clamped ? prev : clamped));
    schedulePersist();
  }, [schedulePersist]);

  // 注：「自动展开 + 切到 Goal tab」的逻辑已移出本 Provider。
  // 旧实现基于 hasGoalPlan 的 false→true 跳变触发，但它无法区分
  // 「当前会话内真正新建计划」与「切换到一个本来就有计划的会话」——
  // 后者在切会话时同样会产生 false→true 跳变，导致误自动弹开侧栏。
  // 现改由 GoalPlanPanel 仅在广播驱动的 reload 路径检测 plans 0→N（真正新建），
  // 经 onGoalPlanCreated 回调到 ChatSurface 再调用 setOpen/setActiveTab。
  // hasGoalPlan 状态本身保留，仍供其它判断使用。

  // ⌘\ 全局快捷键（右侧 workbench）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setOpenState((prev) => !prev);
        schedulePersist();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [schedulePersist]);

  // ⌘B 全局快捷键（左侧 sidebar）。视为用户主动操作，清除自动收起标记。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        setSidebarOpenState(collapsedRef.current);
        setSidebarAutoCollapsedState(false);
        schedulePersist();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [schedulePersist]);

  // 左栏最终收起态 = 用户主动收起 或 右侧挤压自动收起。
  const sidebarCollapsed = !sidebarOpen || sidebarAutoCollapsed;
  collapsedRef.current = sidebarCollapsed;

  // 同步 CSS 变量：右栏宽度
  useEffect(() => {
    document.documentElement.style.setProperty('--za-workbench-width', `${width}px`);
  }, [width]);

  // 同步 CSS 变量：左栏当前宽度（拖拽态由 Resizer 直接覆盖此变量，松手后回落到 state）
  useEffect(() => {
    document.documentElement.style.setProperty('--za-sidebar-current-width', `${sidebarWidth}px`);
  }, [sidebarWidth]);

  // 同步 CSS data 属性：是否展开、sidebar 是否收起（统一来源）
  useEffect(() => {
    document.documentElement.dataset.workbenchOpen = open ? 'true' : 'false';
  }, [open]);
  useEffect(() => {
    document.documentElement.dataset.sidebarCollapsed = sidebarCollapsed ? 'true' : 'false';
  }, [sidebarCollapsed]);

  // 窗口缩放时重新夹紧
  useEffect(() => {
    const onResize = () => setWidthState((prev) => clampWidth(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const activeTab: WorkbenchTabId = useMemo(() => {
    const key = conversationId ?? '__none';
    const stored = normalizeTab(activeTabMap[key]);
    if (stored) return stored;
    // 兜底默认 Plan：从未手动切过 tab 的会话停在 Plan 视图（而非 terminal）。
    return 'plan';
  }, [conversationId, activeTabMap]);

  const value = useMemo<WorkbenchContextValue>(() => ({
    open,
    width,
    activeTab,
    goalSlot,
    hasGoalPlan,
    sidebarAutoCollapsed,
    sidebarOpen,
    sidebarWidth,
    sidebarCollapsed,
    diffTarget,
    filesTarget,
    conversationId,
    setOpen,
    toggleOpen,
    setActiveTab,
    setWidth,
    registerGoalSlot,
    setHasGoalPlan,
    setSidebarAutoCollapsed,
    setSidebarOpen,
    toggleSidebar,
    setSidebarWidth,
    openDiff,
    revealInFiles,
  }), [
    open, width, activeTab, goalSlot, hasGoalPlan, sidebarAutoCollapsed, sidebarOpen, sidebarWidth, sidebarCollapsed,
    diffTarget, filesTarget, conversationId,
    setOpen, toggleOpen, setActiveTab, setWidth, registerGoalSlot, setHasGoalPlan, setSidebarAutoCollapsed,
    setSidebarOpen, toggleSidebar, setSidebarWidth, openDiff, revealInFiles,
  ]);

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench(): WorkbenchContextValue {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) throw new Error('useWorkbench must be used within a WorkbenchProvider');
  return ctx;
}

/**
 * 可选版：在没有 WorkbenchProvider 时返回 null，而不是抛错。
 * 供可能渲染在 Workbench 之外的组件（如聊天消息内的文件路径）安全消费。
 */
export function useWorkbenchOptional(): WorkbenchContextValue | null {
  return useContext(WorkbenchContext);
}
