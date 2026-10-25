import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { BotDocumentReference } from '@peer-agent/protocol';
import { clientApi } from '../clientApi';
import { PeerIcon } from '../ui/icons';
import { MAIN_MIN_WIDTH, WORKBENCH_MIN_WIDTH, useWorkbench } from './WorkbenchContext';
import { WorkbenchPanel } from './WorkbenchPanel';
import { addBrowserTab, createBrowserTabSession } from './browserSessionState';
import { resourceLayoutBounds, resourceWebUrl } from './resourceWorkspaceState';
import './resource-workspace.css';
import { useMotionAllowed } from '../app/hooks/useMotionAllowed';
import { useMotionPresence } from '../app/hooks/useMotionPresence';
import { motionDurationMs } from '../app/state/visualMotion';

export interface BotResourceOwner {
  readonly workspaceId: string;
  readonly conversationId: string | null;
  readonly path: string | null;
}
interface ResourceWorkspaceAdapter {
  readonly owner: BotResourceOwner | null;
  readonly ready: boolean;
  readonly open: boolean;
  readonly navigationCollapsed: boolean;
  readonly searchIntent: { readonly query: string; readonly candidates: readonly string[]; readonly id: number } | null;
  readonly directoryIntent: { readonly path: string; readonly id: number } | null;
  readonly locate: (query: string, candidates?: readonly string[]) => void;
  readonly openReference: (reference: BotDocumentReference) => void;
  readonly openUrl: (url: string) => void;
  readonly launch: () => void;
  readonly close: () => void;
}
const Context = createContext<ResourceWorkspaceAdapter | null>(null);
export const useResourceWorkspace = () => useContext(Context);

export function useBotResourceOwner(
  workspaceId: string | null,
  onOwner: (owner: BotResourceOwner | null) => void,
  conversationHint?: string,
) {
  useLayoutEffect(() => {
    onOwner(workspaceId ? { workspaceId, conversationId: null, path: null } : null);
  }, [workspaceId, onOwner, conversationHint]);
  useEffect(() => {
    if (!workspaceId) return;
    let disposed = false;
    void clientApi.projectAgentGet({ workspaceId }).then(result => {
      if (disposed || !result.ok) return;
      const conversationId = result.profile?.agentConversationId ?? result.item?.profile.agentConversationId;
      if (!conversationId || !result.path) return;
      onOwner({ workspaceId, conversationId, path: result.path });
    }).catch(() => {});
    return () => { disposed = true; };
  }, [workspaceId, onOwner, conversationHint]);
}

export function BotResourceLayout({ owner, active, isZh, children }: {
  readonly owner: BotResourceOwner | null; readonly active: boolean; readonly isZh: boolean; readonly children: ReactNode;
}) {
  const workbench = useWorkbench();
  const root = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const motionAllowed = useMotionAllowed();
  const [exitLayout, setExitLayout] = useState<{
    owner: string; width: number; panelWidth: number; top: number; height: number;
    padding: number; full: boolean; navigationCollapsed: boolean; duration: number;
  } | null>(null);
  const presence = useMotionPresence({ onExitComplete: () => setExitLayout(null), exitDurationMs: exitLayout?.duration });
  const [layoutElement, setLayoutElement] = useState<HTMLDivElement | null>(null);
  const bindLayout = useCallback((element: HTMLDivElement | null) => {
    root.current = element;
    setLayoutElement(element);
  }, []);
  const focusAfterIntent = useRef(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [bounds, setBounds] = useState<(ReturnType<typeof resourceLayoutBounds> & { viewport: number }) | null>(null);
  // No measurement is not evidence that the user's window is narrow.
  const compact = bounds?.compact ?? false;
  const navigationCollapsed = bounds?.navigationCollapsed ?? false;
  const [focusArea, setFocusArea] = useState<'primary' | 'resource'>('primary');
  const [search, setSearch] = useState<{ owner: string; query: string; candidates: readonly string[]; id: number } | null>(null);
  const [directory, setDirectory] = useState<{ owner: string; path: string; id: number } | null>(null);
  const ready = !!owner?.path && !!owner.conversationId && owner.conversationId === workbench.conversationId;
  const closing = presence.exiting && !!exitLayout && exitLayout.owner === owner?.conversationId && ready && active && !workbench.open;
  useLayoutEffect(() => {
    if (exitLayout && (workbench.open || exitLayout.owner !== owner?.conversationId || !ready || !active)) {
      presence.cancelExit(); setExitLayout(null);
    }
  }, [exitLayout, workbench.open, owner?.conversationId, ready, active, presence.cancelExit]);
  const { setOpen } = workbench;
  // A regular Bot switch restores metadata, not an open settings/resource surface.
  useLayoutEffect(() => { setOpen(false); }, [owner?.workspaceId, owner?.conversationId, setOpen]);
  useLayoutEffect(() => {
    const element = layoutElement;
    if (!element) return;
    const measure = () => {
      if (!element.isConnected || element.clientWidth <= 0) return;
      const columnElement = element.querySelector('.bot-column');
      // display:none must not erase the preferred width and cause a collapse/expand loop.
      const column = columnElement ? Number.parseFloat(getComputedStyle(columnElement).width) || 0 : 0;
      const gap = Number.parseFloat(getComputedStyle(element).getPropertyValue('--bot-float-gap')) || 0;
      const next = { ...resourceLayoutBounds(element.clientWidth, column, gap, MAIN_MIN_WIDTH, WORKBENCH_MIN_WIDTH), viewport: element.clientWidth };
      if (next.navigationCollapsed && element.dataset.resourceOpen === 'true' && columnElement?.contains(document.activeElement)) {
        focusAfterIntent.current = true; setFocusRequest(value => value + 1); setFocusArea('primary');
      }
      setBounds(current => current && Object.keys(next).every(key => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    const column = element.querySelector('.bot-column'); if (column) observer?.observe(column);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [layoutElement, active, ready, workbench.open]);
  useLayoutEffect(() => {
    if (!focusAfterIntent.current) return;
    focusAfterIntent.current = false;
    const previous = returnFocus.current;
    if (!workbench.open && previous?.isConnected && root.current?.querySelector('.bot-resource-primary')?.contains(previous)) { previous.focus({ preventScroll: true }); return; }
    const target = root.current?.querySelector<HTMLElement>(focusArea === 'resource'
      ? '.resource-workspace [aria-selected="true"], .resource-workspace button' : '.bot-main textarea, .bot-main button');
    target?.focus({ preventScroll: true });
  }, [focusRequest, focusArea, workbench.open, compact]);
  const reveal = () => {
    presence.cancelExit(); setExitLayout(null);
    if (document.activeElement instanceof HTMLElement && root.current?.querySelector('.bot-resource-primary')?.contains(document.activeElement)) returnFocus.current = document.activeElement;
    if (!workbench.open) workbench.setMaximized(false);
    focusAfterIntent.current = true; setFocusRequest(value => value + 1); setFocusArea('resource'); workbench.setOpen(true);
  };
  const launch = () => { if (ready) { workbench.setActiveTab('launcher'); reveal(); } };
  const adapter: ResourceWorkspaceAdapter = {
    owner, ready, open: ready && active && workbench.open,
    navigationCollapsed: ready && active && workbench.open && navigationCollapsed,
    searchIntent: search?.owner === owner?.conversationId ? search : null,
    directoryIntent: directory?.owner === owner?.conversationId ? directory : null,
    locate: (query, candidates = []) => {
      if (!ready || !owner?.conversationId || !query.trim()) return;
      setSearch(previous => ({ owner: owner.conversationId!, query: query.slice(0, 256), candidates: candidates.slice(0, 256), id: (previous?.id ?? 0) + 1 }));
      workbench.setActiveTab('launcher'); reveal();
    },
    launch,
    close: () => {
      if (!workbench.open) return;
      const element = pane.current, frame = root.current;
      if (motionAllowed && ready && active && element && frame && owner?.conversationId) {
        const rect = element.getBoundingClientRect(), panel = element.querySelector('.resource-workspace')?.getBoundingClientRect();
        if (rect.width > 0 && panel) {
          const full = compact || workbench.maximized;
          setExitLayout({ owner: owner.conversationId, width: rect.width, panelWidth: panel.width,
            top: rect.top - frame.getBoundingClientRect().top, height: rect.height,
            padding: Number.parseFloat(getComputedStyle(element).paddingInlineEnd) || 0,
            full, navigationCollapsed, duration: motionDurationMs(getComputedStyle(element).getPropertyValue(full ? '--za-motion-fast' : '--za-motion-medium')) });
          presence.startExit();
        }
      }
      focusAfterIntent.current = true; setFocusRequest(value => value + 1); setFocusArea('primary'); workbench.setOpen(false);
    },
    openReference: reference => {
      if (ready && reference.workspaceId === owner?.workspaceId) {
        if (reference.kind === 'directory') {
          setDirectory(previous => ({ owner: owner.conversationId!, path: reference.path, id: (previous?.id ?? 0) + 1 }));
          workbench.setActiveTab('files');
        } else workbench.openDocumentReference(reference);
        reveal();
      }
    },
    openUrl: input => {
      const url = resourceWebUrl(input);
      if (!ready || !url) return;
      workbench.setBrowserSession(current => addBrowserTab(current, createBrowserTabSession(undefined, url)));
      workbench.setActiveTab('browser'); reveal();
    },
  };
  return <Context.Provider value={adapter}>
    <div ref={bindLayout} className="bot-resource-layout" data-resource-open={ready && active && workbench.open}
      style={{ '--resource-primary-min': `${bounds?.primaryMin ?? MAIN_MIN_WIDTH}px` } as CSSProperties}
      data-resource-measured-width={bounds?.viewport}
      data-resource-compact={compact} data-resource-focus={focusArea}
      data-resource-navigation-collapsed={ready && active && (workbench.open && navigationCollapsed || closing && !exitLayout?.full && exitLayout?.navigationCollapsed)}
      data-resource-full={ready && active && workbench.open && (compact || workbench.maximized)}
      data-resource-maximized={ready && active && workbench.open && workbench.maximized}>
      {ready && active && workbench.open && (compact || workbench.maximized) ? <div className="resource-navigation-bar">
        <button className="resource-switcher ui-button" type="button" onClick={() => {
          focusAfterIntent.current = true; setFocusRequest(value => value + 1);
          if (!compact) { workbench.setMaximized(false); setFocusArea('primary'); }
          else setFocusArea(current => current === 'primary' ? 'resource' : 'primary');
        }}>{compact && focusArea === 'primary' ? (isZh ? '返回资源' : 'Return to resource') : (isZh ? '返回对话' : 'Return to conversation')}</button>
      </div> : null}
      <div className="bot-resource-primary" onFocusCapture={() => setFocusArea('primary')}>{children}</div>
      <div ref={pane} className={`bot-resource-pane${closing ? exitLayout?.full ? ' motion-exit-slide-inline' : ' motion-exit-collapse-inline' : ''}`}
        data-resource-exiting={closing} data-resource-exit-full={closing && exitLayout?.full === true}
        style={closing && exitLayout ? { '--motion-collapse-inline-from': `${exitLayout.width}px`, '--motion-collapse-inline-padding': `${exitLayout.padding}px`,
          '--resource-retained-width': `${exitLayout.panelWidth}px`, ...(exitLayout.full ? { top: exitLayout.top, height: exitLayout.height, width: exitLayout.width } : {}) } as CSSProperties : undefined}
        onAnimationEnd={presence.onAnimationEnd} inert={closing} aria-hidden={closing || undefined}
        onFocusCapture={() => setFocusArea('resource')}>
      <WorkbenchPanel isZh={isZh} workspacePath={owner?.path ?? null} resourceMode
        resourceVisible={ready && active} resourceExiting={closing} resourceWidthLimit={bounds?.sideMax} botWorkspaceId={owner?.workspaceId} />
      </div>
    </div>
  </Context.Provider>;
}

export function BotResourceButton({ isZh }: { readonly isZh: boolean }) {
  const workspace = useResourceWorkspace();
  return <>{workspace?.navigationCollapsed ? <button type="button" className="bot-profile is-icon" onClick={() => workspace.close()}
    title={isZh ? '收起资源并显示机器人列表' : 'Close resources and show Bot list'}
    aria-label={isZh ? '显示机器人列表' : 'Show Bot list'}><PeerIcon name="panelLeft" size={16} /></button> : null}
    <button type="button" className="bot-profile is-icon" disabled={!workspace?.ready} onClick={() => workspace?.open ? workspace.close() : workspace?.launch()}
    aria-label={isZh ? '工作区' : 'Workspace'} aria-expanded={workspace?.open ?? false}
    title={!workspace?.ready ? (isZh ? '正在确认机器人会话与来源' : 'Resolving the Bot conversation and source') : workspace.open ? (isZh ? '收起工作区' : 'Collapse workspace') : (isZh ? '打开工作区' : 'Open workspace')}>
    <PeerIcon name="panelRight" size={16} />
  </button></>;
}
