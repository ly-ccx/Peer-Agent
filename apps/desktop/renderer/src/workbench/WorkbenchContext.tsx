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

export type WorkbenchTabId = 'goal' | 'terminal' | 'browser' | 'files';

export const WORKBENCH_DEFAULT_WIDTH = 420;
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
}

interface WorkbenchActions {
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setActiveTab: (tab: WorkbenchTabId) => void;
  setWidth: (width: number) => void;
  registerGoalSlot: (el: HTMLElement | null) => void;
  setHasGoalPlan: (has: boolean) => void;
  setSidebarAutoCollapsed: (collapsed: boolean) => void;
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
  return value === 'goal' || value === 'terminal' || value === 'browser' || value === 'files';
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

  const registerGoalSlot = useCallback((el: HTMLElement | null) => {
    setGoalSlotState((prev) => (prev === el ? prev : el));
  }, []);

  const setHasGoalPlan = useCallback((has: boolean) => {
    setHasGoalPlanState((prev) => (prev === has ? prev : has));
  }, []);

  const setSidebarAutoCollapsed = useCallback((collapsed: boolean) => {
    setSidebarAutoCollapsedState((prev) => (prev === collapsed ? prev : collapsed));
  }, []);

  // 自动展开 + 切到 Goal tab：仅在 GoalPlan 从无到有的瞬间触发一次。
  const lastHasGoalPlanRef = useRef<boolean>(false);
  useEffect(() => {
    if (hasGoalPlan && !lastHasGoalPlanRef.current && conversationId) {
      lastHasGoalPlanRef.current = true;
      setOpenState(true);
      setActiveTabMap((prev) => ({ ...prev, [conversationId]: 'goal' }));
      schedulePersist();
    } else if (!hasGoalPlan) {
      lastHasGoalPlanRef.current = false;
    }
  }, [hasGoalPlan, conversationId, schedulePersist]);

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
    conversationId,
    setOpen,
    toggleOpen,
    setActiveTab,
    setWidth,
    registerGoalSlot,
    setHasGoalPlan,
    setSidebarAutoCollapsed,
  }), [
    open, width, activeTab, goalSlot, hasGoalPlan, sidebarAutoCollapsed, conversationId,
    setOpen, toggleOpen, setActiveTab, setWidth, registerGoalSlot, setHasGoalPlan, setSidebarAutoCollapsed,
  ]);

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench(): WorkbenchContextValue {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) throw new Error('useWorkbench must be used within a WorkbenchProvider');
  return ctx;
}
