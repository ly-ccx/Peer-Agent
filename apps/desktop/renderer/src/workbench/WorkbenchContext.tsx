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
import {
  createBrowserSessionState,
  isBlankBrowserSession,
  normalizeBrowserSessionMap,
  normalizeBrowserSessionState,
  workbenchSessionKey,
  type BrowserSessionMap,
  type BrowserSessionState,
} from './browserSessionState';
import { clampWorkbenchWidth } from './workbenchResizeStages';
import {
  createDocumentSessionState,
  createDocumentTabSession,
  normalizeDocumentSessionMap,
  normalizeDocumentSessionState,
  openDocumentTab,
  type DocumentSessionMap,
  type DocumentSessionState,
  type WorkbenchFileMode,
} from './documentSessionState';
import { defaultModeForKind, detectFileKind } from './file-preview/fileTypes';
import { workbenchIsLayoutVisible } from './workbenchLayoutProjection';
import {
  rememberLeavingBrowserConversation,
  rememberPreparedBrowser,
  resolveBrowserPanelReveal,
} from './browserPanelReveal';
import {
  normalizeWorkbenchOpenMap,
  resolveWorkbenchOpen,
  updateWorkbenchOpen,
  type WorkbenchOpenMap,
} from './workbenchOpenState';
import {
  normalizeWorkbenchTab,
  normalizeWorkbenchTabMap,
  type WorkbenchTabId,
} from './workbenchTabState';

// 历史 'goal' tab 已正名为 'plan'，历史 'terminal' 占位 tab 已移除；旧 'diff'
// 一级入口迁移为 'documents'，Preview / Source / Diff 留在文档内部。
export type { WorkbenchTabId } from './workbenchTabState';
export type { WorkbenchFileMode } from './documentSessionState';

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
/** 键盘 Home / 旧调用仍可用；拖拽上限改走窗口宽度，不再被 900px 卡住。 */
export const WORKBENCH_MAX_WIDTH = 900;
/** 渐进式拖拽：0.6 自动收左栏，0.8 自动全屏；反向带滞回。 */
export {
  WORKBENCH_MAXIMIZE_RATIO,
  WORKBENCH_MAXIMIZE_RESTORE_RATIO,
  WORKBENCH_SIDEBAR_COLLAPSE_RATIO,
  WORKBENCH_SIDEBAR_RESTORE_RATIO,
} from './workbenchResizeStages';
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
  /** 旧版窗口级开合状态，仅作为迁移默认值读取。 */
  open?: boolean;
  openByConversation?: WorkbenchOpenMap;
  width?: number;
  activeTab?: Record<string, WorkbenchTabId>;
  browserSessions?: BrowserSessionMap;
  documentSessions?: DocumentSessionMap;
  sidebarOpen?: boolean;
  sidebarWidth?: number;
}

interface WorkbenchState {
  open: boolean;
  width: number;
  /** 临时铺满当前布局宿主；不持久化，恢复后继续使用原 width。 */
  maximized: boolean;
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
  filesTarget: WorkbenchFilesTarget | null;
  browserSession: BrowserSessionState;
  documentSession: DocumentSessionState;
  /** 工作台点击后台线程卡片后，右侧 Threads 面板聚焦的 shell taskId。 */
  focusThreadTaskId: string | null;
  /** 根工作台才承担全局 Browser 调度；会话抽屉只表达当前会话。 */
  layoutHost: 'root' | 'local';
  /** 后台 Task 已拉起、需要继续挂着 WebContents 的会话（不含当前前台会话）。 */
  preparedBrowserConversations: readonly string[];
}

type BrowserSessionUpdater =
  | BrowserSessionState
  | ((current: BrowserSessionState) => BrowserSessionState);

type DocumentSessionUpdater =
  | DocumentSessionState
  | ((current: DocumentSessionState) => DocumentSessionState);

interface WorkbenchActions {
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setActiveTab: (tab: WorkbenchTabId) => void;
  setWidth: (width: number) => void;
  setMaximized: (maximized: boolean) => void;
  registerGoalSlot: (el: HTMLElement | null) => void;
  setHasGoalPlan: (has: boolean) => void;
  setSidebarAutoCollapsed: (collapsed: boolean) => void;
  /** 用户主动展开/收起左栏（toggle 按钮、⌘B）。主动操作会清除自动收起标记。 */
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  /** 拖拽松手落定左栏宽度并持久化。 */
  setSidebarWidth: (width: number) => void;
  openFile: (
    absPath: string,
    workspaceRoot?: string,
    relPath?: string,
    options?: { readonly preferredMode?: WorkbenchFileMode },
  ) => void;
  openDiff: (absPath: string, workspaceRoot?: string, relPath?: string) => void;
  revealInFiles: (absPath: string, workspaceRoot?: string, relPath?: string) => void;
  /** 展开右侧面板并打开后台线程 Tab；可选聚焦某个 shell taskId。 */
  openBackgroundThread: (taskId?: string | null) => void;
  setBrowserSession: (next: BrowserSessionUpdater) => void;
  setBrowserSessionFor: (targetConversationId: string, next: BrowserSessionUpdater) => void;
  resolveBrowserSession: (targetConversationId: string | null) => BrowserSessionState;
  setDocumentSession: (next: DocumentSessionUpdater) => void;
}

type WorkbenchContextValue = WorkbenchState & WorkbenchActions & { conversationId: string | null };

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

function clampWidth(value: number): number {
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : WORKBENCH_MAX_WIDTH;
  return clampWorkbenchWidth(value, viewportWidth, WORKBENCH_MIN_WIDTH);
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

interface WorkbenchProviderProps {
  readonly conversationId: string | null;
  readonly isPageActive: boolean;
  /**
   * 嵌套工作台（会话抽屉）只把开合写到自己的面板，不投影到 :root。
   * 否则会和主会话第三列抢 `--za-workbench-width` / `data-workbench-open`。
   */
  readonly layoutHost?: 'root' | 'local';
  readonly children: ReactNode;
}

export function WorkbenchProvider({
  conversationId,
  isPageActive,
  layoutHost = 'root',
  children,
}: WorkbenchProviderProps) {
  const initial = readWorkbenchSettings(clientApi.initialSettings);
  const legacyOpenDefault = initial.open === true;
  const [openByConversation, setOpenByConversation] = useState<WorkbenchOpenMap>(
    normalizeWorkbenchOpenMap(initial.openByConversation),
  );
  const [width, setWidthState] = useState<number>(clampWidth(initial.width ?? WORKBENCH_DEFAULT_WIDTH));
  const [maximized, setMaximizedState] = useState(false);
  const [activeTabMap, setActiveTabMap] = useState<Record<string, WorkbenchTabId>>(
    normalizeWorkbenchTabMap(initial.activeTab),
  );
  const [browserSessionMap, setBrowserSessionMap] = useState<BrowserSessionMap>(
    normalizeBrowserSessionMap(initial.browserSessions),
  );
  const defaultBrowserSessionsRef = useRef<BrowserSessionMap>({});
  const [documentSessionMap, setDocumentSessionMap] = useState<DocumentSessionMap>(
    normalizeDocumentSessionMap(initial.documentSessions),
  );
  const defaultDocumentSessionsRef = useRef<DocumentSessionMap>({});
  const [goalSlot, setGoalSlotState] = useState<HTMLElement | null>(null);
  const [hasGoalPlan, setHasGoalPlanState] = useState<boolean>(false);
  const [sidebarAutoCollapsed, setSidebarAutoCollapsedState] = useState<boolean>(false);
  const [sidebarOpen, setSidebarOpenState] = useState<boolean>(initial.sidebarOpen !== false);
  const [sidebarWidth, setSidebarWidthState] = useState<number>(
    clampSidebarWidth(initial.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH),
  );
  // 当前「有效收起」态的最新值（供 toggle/⌘B 在回调中读取，无需把状态加进依赖）。
  const collapsedRef = useRef<boolean>(initial.sidebarOpen === false);
  const [filesTarget, setFilesTarget] = useState<WorkbenchFilesTarget | null>(null);
  const filesNonceRef = useRef(0);
  const [focusThreadTaskId, setFocusThreadTaskId] = useState<string | null>(null);
  const [preparedBrowserConversations, setPreparedBrowserConversations] = useState<string[]>([]);
  const previousConversationIdRef = useRef<string | null>(conversationId);
  let livePreparedBrowserConversations = preparedBrowserConversations;
  if (previousConversationIdRef.current !== conversationId) {
    const leavingId = previousConversationIdRef.current;
    previousConversationIdRef.current = conversationId;
    if (leavingId) {
      const leavingKey = workbenchSessionKey(leavingId);
      const leavingSession = browserSessionMap[leavingKey]
        ?? defaultBrowserSessionsRef.current[leavingKey]
        ?? null;
      livePreparedBrowserConversations = rememberLeavingBrowserConversation(
        preparedBrowserConversations,
        leavingId,
        isBlankBrowserSession(leavingSession),
      );
      if (livePreparedBrowserConversations.join('\0') !== preparedBrowserConversations.join('\0')) {
        setPreparedBrowserConversations(livePreparedBrowserConversations);
      }
    }
  }

  const currentSessionKey = workbenchSessionKey(conversationId);
  const open = resolveWorkbenchOpen(openByConversation, conversationId, legacyOpenDefault);
  const openRef = useRef(open);
  openRef.current = open;

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef({
    openByConversation,
    width,
    activeTabMap,
    browserSessionMap,
    documentSessionMap,
    sidebarOpen,
    sidebarWidth,
  });
  latestRef.current = {
    openByConversation,
    width,
    activeTabMap,
    browserSessionMap,
    documentSessionMap,
    sidebarOpen,
    sidebarWidth,
  };

  const schedulePersist = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const {
        openByConversation: o,
        width: w,
        activeTabMap: m,
        browserSessionMap: b,
        documentSessionMap: d,
        sidebarOpen: so,
        sidebarWidth: sw,
      } = latestRef.current;
      void clientApi
        .updateSettings({
          workbench: {
            // 旧布尔值显式归零，之后由会话映射单独决定开合。
            open: false,
            openByConversation: o,
            width: w,
            activeTab: m,
            browserSessions: b,
            documentSessions: d,
            sidebarOpen: so,
            sidebarWidth: sw,
          },
        })
        .catch(() => {});
    }, 250);
  }, []);

  useEffect(() => () => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
  }, []);

  const setOpen = useCallback((next: boolean) => {
    setOpenByConversation((prev) => updateWorkbenchOpen(prev, conversationId, next));
    if (!next) setMaximizedState(false);
    schedulePersist();
  }, [conversationId, schedulePersist]);

  const toggleOpen = useCallback(() => {
    const next = !openRef.current;
    setOpenByConversation((prev) => updateWorkbenchOpen(prev, conversationId, next));
    if (!next) setMaximizedState(false);
    schedulePersist();
  }, [conversationId, schedulePersist]);

  const setWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidthState((prev) => (prev === clamped ? prev : clamped));
    schedulePersist();
  }, [schedulePersist]);

  const setMaximized = useCallback((next: boolean) => {
    setMaximizedState(next);
  }, []);

  const setActiveTab = useCallback((tab: WorkbenchTabId) => {
    const key = workbenchSessionKey(conversationId);
    setActiveTabMap((prev) => {
      if (prev[key] === tab) return prev;
      return { ...prev, [key]: tab };
    });
    schedulePersist();
  }, [conversationId, schedulePersist]);

  const resolveBrowserSession = useCallback((targetConversationId: string | null) => {
    const key = workbenchSessionKey(targetConversationId);
    const stored = browserSessionMap[key];
    if (stored) return stored;
    const existing = defaultBrowserSessionsRef.current[key];
    if (existing) return existing;
    const created = createBrowserSessionState();
    defaultBrowserSessionsRef.current[key] = created;
    return created;
  }, [browserSessionMap]);

  const setBrowserSessionFor = useCallback((targetConversationId: string, next: BrowserSessionUpdater) => {
    const key = workbenchSessionKey(targetConversationId);
    setBrowserSessionMap((prev) => {
      const current = prev[key]
        ?? defaultBrowserSessionsRef.current[key]
        ?? createBrowserSessionState();
      defaultBrowserSessionsRef.current[key] = current;
      const resolved = typeof next === 'function' ? next(current) : next;
      if (resolved === current) return prev;
      const normalized = normalizeBrowserSessionState(resolved);
      return { ...prev, [key]: normalized };
    });
    schedulePersist();
  }, [schedulePersist]);

  const setBrowserSession = useCallback((next: BrowserSessionUpdater) => {
    if (!conversationId) {
      setBrowserSessionFor('__none', next);
      return;
    }
    setBrowserSessionFor(conversationId, next);
  }, [conversationId, setBrowserSessionFor]);

  useEffect(() => clientApi.onBrowserPanelRevealRequest((request) => {
    const requestId = typeof request.conversationId === 'string' ? request.conversationId.trim() : '';
    const requestKey = workbenchSessionKey(requestId || null);
    const existing = latestRef.current.browserSessionMap[requestKey]
      ?? defaultBrowserSessionsRef.current[requestKey]
      ?? null;
    const decision = resolveBrowserPanelReveal({
      requestConversationId: requestId,
      hostConversationId: conversationId,
      layoutHost,
      focus: request.focus,
      hostOpen: openRef.current,
      hostBrowserActive: latestRef.current.activeTabMap[currentSessionKey] === 'browser',
      requestSessionExists: existing != null,
    });
    if (!decision.accept) return;
    if (decision.prepareSession && !existing) {
      setBrowserSessionFor(requestId, createBrowserSessionState());
    }
    if (decision.mountPrepared && requestId !== conversationId) {
      setPreparedBrowserConversations((prev) => rememberPreparedBrowser(prev, requestId));
    }
    if (decision.stealUi) {
      setOpen(true);
      setActiveTab('browser');
    }
    void clientApi.acknowledgeBrowserPanelReveal({
      requestId: request.requestId,
      conversationId: requestId,
      ok: true,
      status: decision.status,
      sessionId: requestKey,
      focused: decision.stealUi,
    });
  }), [conversationId, currentSessionKey, layoutHost, setActiveTab, setBrowserSessionFor, setOpen]);

  const setDocumentSession = useCallback((next: DocumentSessionUpdater) => {
    const key = workbenchSessionKey(conversationId);
    setDocumentSessionMap((prev) => {
      const current = prev[key]
        ?? defaultDocumentSessionsRef.current[key]
        ?? createDocumentSessionState();
      defaultDocumentSessionsRef.current[key] = current;
      const resolved = typeof next === 'function' ? next(current) : next;
      if (resolved === current) return prev;
      const normalized = normalizeDocumentSessionState(resolved);
      return { ...prev, [key]: normalized };
    });
    schedulePersist();
  }, [conversationId, schedulePersist]);

  const openFile = useCallback((
    absPath: string,
    workspaceRoot?: string,
    relPath?: string,
    options?: { readonly preferredMode?: WorkbenchFileMode },
  ) => {
    const preferredMode = options?.preferredMode;
    const tab = createDocumentTabSession(absPath, {
      workspaceRoot,
      relPath,
      mode: preferredMode ?? defaultModeForKind(detectFileKind(absPath)),
    });
    setDocumentSession((current) => openDocumentTab(current, tab, {
      replaceMode: preferredMode != null,
    }));
    const key = workbenchSessionKey(conversationId);
    setActiveTabMap((prev) => (
      prev[key] === 'documents' ? prev : { ...prev, [key]: 'documents' }
    ));
    setOpenByConversation((prev) => updateWorkbenchOpen(prev, conversationId, true));
    schedulePersist();
  }, [conversationId, schedulePersist, setDocumentSession]);

  const openDiff = useCallback((absPath: string, workspaceRoot?: string, relPath?: string) => {
    openFile(absPath, workspaceRoot, relPath, { preferredMode: 'diff' });
  }, [openFile]);

  const revealInFiles = useCallback((absPath: string, workspaceRoot?: string, relPath?: string) => {
    filesNonceRef.current += 1;
    setFilesTarget({ absPath, workspaceRoot, relPath, nonce: filesNonceRef.current });
    const key = workbenchSessionKey(conversationId);
    setActiveTabMap((prev) => (prev[key] === 'files' ? prev : { ...prev, [key]: 'files' }));
    setOpenByConversation((prev) => updateWorkbenchOpen(prev, conversationId, true));
    schedulePersist();
  }, [conversationId, schedulePersist]);

  const openBackgroundThread = useCallback((taskId?: string | null) => {
    const normalized =
      typeof taskId === 'string' && taskId.trim() !== ''
        ? taskId.replace(/^shell:/, '').trim()
        : null;
    setFocusThreadTaskId(normalized);
    const key = workbenchSessionKey(conversationId);
    setActiveTabMap((prev) => (prev[key] === 'threads' ? prev : { ...prev, [key]: 'threads' }));
    setOpenByConversation((prev) => updateWorkbenchOpen(prev, conversationId, true));
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
    if (!isPageActive) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setOpenByConversation((prev) => updateWorkbenchOpen(prev, conversationId, !openRef.current));
        schedulePersist();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [conversationId, isPageActive, schedulePersist]);

  // ⌘B 全局快捷键（左侧 sidebar）。视为用户主动操作，清除自动收起标记。
  useEffect(() => {
    if (!isPageActive) return undefined;
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
  }, [isPageActive, schedulePersist]);

  // 左栏最终收起态 = 用户主动收起 或 右侧挤压自动收起。
  const sidebarCollapsed = !sidebarOpen || sidebarAutoCollapsed;
  collapsedRef.current = sidebarCollapsed;

  // 同步 CSS 变量：右栏宽度
  useEffect(() => {
    if (layoutHost !== 'root') return;
    document.documentElement.style.setProperty('--za-workbench-width', `${width}px`);
  }, [width, layoutHost]);

  // 同步 CSS 变量：左栏当前宽度（拖拽态由 Resizer 直接覆盖此变量，松手后回落到 state）
  useEffect(() => {
    if (layoutHost !== 'root') return;
    document.documentElement.style.setProperty('--za-sidebar-current-width', `${sidebarWidth}px`);
  }, [sidebarWidth, layoutHost]);

  // 根布局只投影当前可见的 Workbench；离开 Chat 时保留 open 状态但释放第三列。
  useEffect(() => {
    if (layoutHost !== 'root') return;
    const visible = workbenchIsLayoutVisible(open, isPageActive);
    document.documentElement.dataset.workbenchOpen = visible ? 'true' : 'false';
    document.documentElement.dataset.workbenchMaximized = visible && maximized ? 'true' : 'false';
    return () => {
      delete document.documentElement.dataset.workbenchMaximized;
    };
  }, [open, maximized, isPageActive, layoutHost]);
  useEffect(() => {
    if (layoutHost !== 'root') return;
    document.documentElement.dataset.sidebarCollapsed = sidebarCollapsed ? 'true' : 'false';
  }, [sidebarCollapsed, layoutHost]);

  // 窗口缩放时重新夹紧
  useEffect(() => {
    const onResize = () => setWidthState((prev) => clampWidth(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const activeTab: WorkbenchTabId = useMemo(() => {
    const key = workbenchSessionKey(conversationId);
    const stored = normalizeWorkbenchTab(activeTabMap[key]);
    if (stored === 'browser') {
      const session = browserSessionMap[key] ?? defaultBrowserSessionsRef.current[key];
      // 仅空白 about:blank 时不要在冷启动恢复 browser tab（避免一打开就露出空浏览器）。
      if (!session || isBlankBrowserSession(session)) return 'plan';
      return 'browser';
    }
    if (stored) return stored;
    // 兜底默认 Plan：从未手动切过 tab 的会话停在 Plan 视图。
    return 'plan';
  }, [conversationId, activeTabMap, browserSessionMap]);

  const browserSession = useMemo(() => {
    const stored = browserSessionMap[currentSessionKey];
    if (stored) return stored;
    const existing = defaultBrowserSessionsRef.current[currentSessionKey];
    if (existing) return existing;
    const created = createBrowserSessionState();
    defaultBrowserSessionsRef.current[currentSessionKey] = created;
    return created;
  }, [browserSessionMap, currentSessionKey]);

  const documentSession = useMemo(() => {
    const stored = documentSessionMap[currentSessionKey];
    if (stored) return stored;
    const existing = defaultDocumentSessionsRef.current[currentSessionKey];
    if (existing) return existing;
    const created = createDocumentSessionState();
    defaultDocumentSessionsRef.current[currentSessionKey] = created;
    return created;
  }, [documentSessionMap, currentSessionKey]);

  const value = useMemo<WorkbenchContextValue>(() => ({
    open,
    width,
    maximized,
    activeTab,
    goalSlot,
    hasGoalPlan,
    sidebarAutoCollapsed,
    sidebarOpen,
    sidebarWidth,
    sidebarCollapsed,
    filesTarget,
    browserSession,
    documentSession,
    focusThreadTaskId,
    layoutHost,
    preparedBrowserConversations: livePreparedBrowserConversations,
    conversationId,
    setOpen,
    toggleOpen,
    setActiveTab,
    setWidth,
    setMaximized,
    registerGoalSlot,
    setHasGoalPlan,
    setSidebarAutoCollapsed,
    setSidebarOpen,
    toggleSidebar,
    setSidebarWidth,
    openFile,
    openDiff,
    revealInFiles,
    openBackgroundThread,
    setBrowserSession,
    setBrowserSessionFor,
    resolveBrowserSession,
    setDocumentSession,
  }), [
    open, width, maximized, activeTab, goalSlot, hasGoalPlan, sidebarAutoCollapsed, sidebarOpen, sidebarWidth, sidebarCollapsed,
    filesTarget, browserSession, documentSession, focusThreadTaskId, layoutHost, livePreparedBrowserConversations, conversationId,
    setOpen, toggleOpen, setActiveTab, setWidth, setMaximized, registerGoalSlot, setHasGoalPlan, setSidebarAutoCollapsed,
    setSidebarOpen, toggleSidebar, setSidebarWidth, openFile, openDiff, revealInFiles, openBackgroundThread,
    setBrowserSession, setBrowserSessionFor, resolveBrowserSession, setDocumentSession,
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
