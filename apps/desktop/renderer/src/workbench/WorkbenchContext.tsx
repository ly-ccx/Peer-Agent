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

export type WorkbenchTabId = 'goal' | 'terminal' | 'browser' | 'files' | 'diff';

export interface WorkbenchDiffTarget {
  readonly absPath: string;
  readonly workspaceRoot?: string;
  /** 原始相对路径（解析前），用于主进程跨已知 workspace 回退查找。 */
  readonly relPath?: string;
}

export const WORKBENCH_DEFAULT_WIDTH = 600;
export const WORKBENCH_MIN_WIDTH = 320;
export const WORKBENCH_MAX_WIDTH = 900;
export const WORKBENCH_MAX_VW_RATIO = 0.55;
export const MAIN_MIN_WIDTH = 480;

interface WorkbenchSettingsShape {
  open?: boolean;
  width?: number;
  activeTab?: Record<string, WorkbenchTabId>;
}

interface WorkbenchState {
  open: boolean;
  width: number;
  activeTab: WorkbenchTabId;
  goalSlot: HTMLElement | null;
  hasGoalPlan: boolean;
  sidebarAutoCollapsed: boolean;
  diffTarget: WorkbenchDiffTarget | null;
}

interface WorkbenchActions {
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setActiveTab: (tab: WorkbenchTabId) => void;
  setWidth: (width: number) => void;
  registerGoalSlot: (el: HTMLElement | null) => void;
  setHasGoalPlan: (has: boolean) => void;
  setSidebarAutoCollapsed: (collapsed: boolean) => void;
  openDiff: (absPath: string, workspaceRoot?: string, relPath?: string) => void;
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

function readWorkbenchSettings(raw: unknown): WorkbenchSettingsShape {
  if (!raw || typeof raw !== 'object') return {};
  const wb = (raw as Record<string, unknown>).workbench;
  if (!wb || typeof wb !== 'object') return {};
  return wb as WorkbenchSettingsShape;
}

function isValidTab(value: unknown): value is WorkbenchTabId {
  return (
    value === 'goal' ||
    value === 'terminal' ||
    value === 'browser' ||
    value === 'files' ||
    value === 'diff'
  );
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
    initial.activeTab && typeof initial.activeTab === 'object' ? { ...initial.activeTab } : {},
  );
  const [goalSlot, setGoalSlotState] = useState<HTMLElement | null>(null);
  const [hasGoalPlan, setHasGoalPlanState] = useState<boolean>(false);
  const [sidebarAutoCollapsed, setSidebarAutoCollapsedState] = useState<boolean>(false);
  const [diffTarget, setDiffTarget] = useState<WorkbenchDiffTarget | null>(null);

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef({ open, width, activeTabMap });
  latestRef.current = { open, width, activeTabMap };

  const schedulePersist = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const { open: o, width: w, activeTabMap: m } = latestRef.current;
      void clientApi
        .updateSettings({ workbench: { open: o, width: w, activeTab: m } })
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

  const registerGoalSlot = useCallback((el: HTMLElement | null) => {
    setGoalSlotState((prev) => (prev === el ? prev : el));
  }, []);

  const setHasGoalPlan = useCallback((has: boolean) => {
    setHasGoalPlanState((prev) => (prev === has ? prev : has));
  }, []);

  const setSidebarAutoCollapsed = useCallback((collapsed: boolean) => {
    setSidebarAutoCollapsedState((prev) => (prev === collapsed ? prev : collapsed));
  }, []);

  // 注：「自动展开 + 切到 Goal tab」的逻辑已移出本 Provider。
  // 旧实现基于 hasGoalPlan 的 false→true 跳变触发，但它无法区分
  // 「当前会话内真正新建计划」与「切换到一个本来就有计划的会话」——
  // 后者在切会话时同样会产生 false→true 跳变，导致误自动弹开侧栏。
  // 现改由 GoalPlanPanel 仅在广播驱动的 reload 路径检测 plans 0→N（真正新建），
  // 经 onGoalPlanCreated 回调到 ChatSurface 再调用 setOpen/setActiveTab。
  // hasGoalPlan 状态本身保留，仍供其它判断使用。

  // ⌘\ 全局快捷键
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

  // 同步 CSS 变量：宽度
  useEffect(() => {
    document.documentElement.style.setProperty('--za-workbench-width', `${width}px`);
  }, [width]);

  // 同步 CSS data 属性：是否展开、sidebar 是否自动收起
  useEffect(() => {
    document.documentElement.dataset.workbenchOpen = open ? 'true' : 'false';
  }, [open]);
  useEffect(() => {
    document.documentElement.dataset.sidebarCollapsed = sidebarAutoCollapsed ? 'true' : 'false';
  }, [sidebarAutoCollapsed]);

  // 窗口缩放时重新夹紧
  useEffect(() => {
    const onResize = () => setWidthState((prev) => clampWidth(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const activeTab: WorkbenchTabId = useMemo(() => {
    const key = conversationId ?? '__none';
    const stored = activeTabMap[key];
    if (isValidTab(stored)) return stored;
    return 'terminal';
  }, [conversationId, activeTabMap]);

  const value = useMemo<WorkbenchContextValue>(() => ({
    open,
    width,
    activeTab,
    goalSlot,
    hasGoalPlan,
    sidebarAutoCollapsed,
    diffTarget,
    conversationId,
    setOpen,
    toggleOpen,
    setActiveTab,
    setWidth,
    registerGoalSlot,
    setHasGoalPlan,
    setSidebarAutoCollapsed,
    openDiff,
  }), [
    open, width, activeTab, goalSlot, hasGoalPlan, sidebarAutoCollapsed, diffTarget, conversationId,
    setOpen, toggleOpen, setActiveTab, setWidth, registerGoalSlot, setHasGoalPlan, setSidebarAutoCollapsed, openDiff,
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
