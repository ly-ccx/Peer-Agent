import { useEffect, useMemo, useState } from 'react';
import { prefersReducedMotion, useMotionPresence } from '../../app/hooks/useMotionPresence.ts';
import {
  projectTaskMonitorArtifacts,
  projectTaskMonitorEnvironment,
  projectTaskMonitorRuns,
  selectConversationTaskOverviewItem,
  taskMonitorProgressHeadline,
} from '../taskMonitorRail.ts';
import {
  projectTaskOverviewArtifacts,
  MAX_VISIBLE_ARTIFACTS_PER_KIND,
  type TaskArtifactProjection,
} from '../../app/pages/taskOverviewArtifacts.ts';
import { useTaskOverview } from '../../app/hooks/useTaskOverview';
import { useBackgroundRunsContext } from '../GlobalBackgroundTasksButton';
import { BackgroundRunDetails } from '../BackgroundRunDetails';
import { useWorkbenchOptional } from '../WorkbenchContext';
import { reconcileStopRequest, type StopRequest } from '../backgroundRuntimeState.ts';
import type { ManagedShellTask } from '@peer-agent/protocol';
import type { ChatMsg } from '../../chat/state/types.ts';
import { projectMonitorSources, type MonitorSource } from '../taskMonitorSources.ts';
import { clientApi } from '../../clientApi';
import { Dropdown } from '../../app/components/Dropdown';
import type { DropdownOption } from '../../app/components/dropdownMenu';

/**
 * 任务监控卡片 —— 单张圆角卡片 + 内部分区标签（用户 2026-09-16 截图定稿）。
 *
 * 形态：一张浅底圆角卡片；内部按 环境信息 / 技能与 MCP / 产出 / 网页查阅 分区，
 * 每区一行「图标 + 文本」，底部「查看更多 (N)」。进度与后台任务合并进任务分区。
 *
 * 治理边界：
 * - 挂载与让位：由 ChatSurface 挂在 .chat-surface 内（见 chat-surface.css），本组件不管布局；
 * - 技能与 MCP 来自当前会话结构化调用，不读取安装清单；
 * - 网页查阅取 WorkbenchContext 的会话 browserSession.tabs（url + title）；
 * - 产出复用任务总览投影（含治理 ref 过滤与上限截断），禁止放宽。
 */

const ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function BranchIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="9" r="2.2" />
      <path d="M6 7.2v9.6M8.2 5h5.3A2.5 2.5 0 0 1 16 7.5V9" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3 7a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function DeviceIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="3" y="4" width="18" height="13" rx="1.5" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9.5l3 2.5-3 2.5M12.5 15h4" />
    </svg>
  );
}

function HammerIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="m14.5 5.5 4 4L21 7l-4.5-4.5-2 2z" />
      <path d="m13 7-8.5 8.5a2.1 2.1 0 0 0 3 3L16 10" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </svg>
  );
}

function ArtifactIcon({ kind }: { readonly kind: 'code' | 'file' | 'image' }) {
  if (kind === 'image') {
    return (
      <svg {...ICON_PROPS}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.6" />
        <path d="m21 16-5-5-9 9" />
      </svg>
    );
  }
  return (
    <svg {...ICON_PROPS}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** 分区：卡内一组，只渲染标题 + 行；空分区整段不渲染。 */
function MonitorSection({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="task-monitor-section" aria-label={title}>
      <h3 className="task-monitor-section-title">{title}</h3>
      {children}
    </section>
  );
}

function MonitorRow({ icon, label, value, detail, onClick, control }: {
  readonly icon: React.ReactNode;
  readonly label?: string;
  readonly value: string;
  readonly detail?: string;
  readonly onClick?: () => void;
  readonly control?: React.ReactNode;
}) {
  const content = (
    <>
      <span className="task-monitor-row-icon">{icon}</span>
      {label ? <span className="task-monitor-row-label">{label}</span> : null}
      {control ?? (
        <span className="task-monitor-row-value" title={detail ?? value}>{value}</span>
      )}
    </>
  );
  if (control) {
    return <div className="task-monitor-row task-monitor-row--control">{content}</div>;
  }
  if (!onClick) {
    return <div className="task-monitor-row">{content}</div>;
  }
  return (
    <button type="button" className="task-monitor-row task-monitor-row--action" onClick={onClick}>
      {content}
    </button>
  );
}

/** URL → 短标签：主机 + 首段路径，超过 28 字符截断（对齐截图的 cd.aone…/unite/micr... 形态）。 */
function urlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const segment = parsed.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    const label = segment ? `${host}/${segment}` : host;
    return label.length > 30 ? `${label.slice(0, 29)}…` : label;
  } catch {
    const trimmed = url.trim();
    return trimmed.length > 30 ? `${trimmed.slice(0, 29)}…` : trimmed;
  }
}

function environmentRowLabel(id: string, isZh: boolean): string | undefined {
  if (id === 'current-head') return isZh ? '当前工作区' : 'Current workspace';
  if (id === 'source') return isZh ? '任务源头' : 'Task source';
  return undefined;
}

export function TaskMonitorRailView({
  isZh,
  workspacePath,
  currentHead,
  sourceBranch,
  workspaceIsGit,
  currentIsolation = null,
  conversationId,
  messages,
  active,
  visible,
  onExitComplete,
  canSelectSource = false,
  sourceOptions = [],
  isolationValue,
  isolationOptions = [],
  canChangeIsolation = false,
  onSelectEnv,
  onCreateBranch,
  onClose,
}: {
  readonly isZh: boolean;
  readonly workspacePath: string | null;
  readonly currentHead: string | null;
  readonly sourceBranch: string | null;
  readonly workspaceIsGit: boolean | null;
  /** Current task fact, not the preference for the next task. null means unknown. */
  readonly currentIsolation?: boolean | null;
  readonly conversationId: string | null;
  readonly messages: readonly ChatMsg[];
  readonly canSelectSource?: boolean;
  readonly sourceOptions?: readonly DropdownOption[];
  readonly isolationValue?: string;
  readonly isolationOptions?: readonly DropdownOption[];
  readonly canChangeIsolation?: boolean;
  readonly onSelectEnv?: (next: string) => void;
  readonly onCreateBranch?: () => void;
  /**
   * 本视图是否在当前 ChatSurface 内真正可见。
   *
   * 收起时仍保留组件状态，但必须显式门控 taskOverview，避免未打开监控栏时多挂一路
   * 轮询与广播订阅——那正是 useTaskOverview.performance.test.ts 在守的调用点成本。
   */
  readonly active: boolean;
  readonly visible: boolean;
  readonly onExitComplete: () => void;
  readonly onClose: () => void;
}) {
  const { exiting, startExit, onAnimationEnd } = useMotionPresence({ onExitComplete, exitDurationMs: 240 });
  useEffect(() => {
    if (!visible) {
      if (prefersReducedMotion()) onExitComplete();
      else startExit();
    }
  }, [visible, startExit, onExitComplete]);
  const workbench = useWorkbenchOptional();
  // 复用 Provider 的单一轮询 reader，避免第二套 poller 重复打主进程。
  const runsReader = useBackgroundRunsContext();
  const environment = useMemo(
    () => projectTaskMonitorEnvironment({
      workspacePath,
      currentHead,
      sourceBranch,
      isGit: workspaceIsGit,
      isZh,
    }),
    [currentHead, isZh, sourceBranch, workspaceIsGit, workspacePath],
  );

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => setExpanded({}), [conversationId]);
  const moreButton = (section: string, total: number, limit: number) => total > limit ? (
    <button type="button" className="task-monitor-more" aria-expanded={!!expanded[section]}
      onClick={() => setExpanded((current) => ({ ...current, [section]: !current[section] }))}>
      {expanded[section] ? (isZh ? '收起' : 'Show less')
        : (isZh ? `查看更多 (${total - limit})` : `View more (${total - limit})`)}
    </button>
  ) : null;

  const sources = useMemo(() => projectMonitorSources(messages,
    workbench?.conversationId === conversationId ? workbench.browserSession.tabs : []),
  [messages, conversationId, workbench?.conversationId, workbench?.browserSession.tabs]);
  const [selectedSource, setSelectedSource] = useState<MonitorSource | null>(null);
  useEffect(() => setSelectedSource(null), [conversationId]);
  const openSource = (source: MonitorSource) => {
    if (source.kind === 'file') {
      workbench?.openFile(source.path, workspacePath ?? undefined);
    } else if (source.kind === 'web') {
      workbench?.setBrowserSession((session) => ({ ...session, activeTabId: source.tabId }));
      workbench?.setActiveTab('browser');
      workbench?.setOpen(true);
    } else {
      setSelectedSource((current) => current?.id === source.id ? null : source);
    }
  };
  const sourceMessage = selectedSource && 'messageId' in selectedSource
    ? messages.find((message) => message.id === selectedSource.messageId) : undefined;
  const selectedCall = selectedSource?.kind === 'tool' ? sourceMessage?.segments?.find(
    (segment) => segment.type === 'tool-call' && segment.toolCallId === selectedSource.toolCallId) : undefined;
  const selectedAttachment = selectedSource?.kind === 'attachment' ? sourceMessage?.attachments?.find(
    (attachment) => attachment.id === selectedSource.attachmentId) : undefined;

  // 后台任务详情内联展开：本栏内的选中态。
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // 停止确认的本地态：与 BackgroundRuntimePanel 相同的两段式
  //（onConfirm 进入 confirm → onStop 校验后走 stops.stop）。
  const [confirmation, setConfirmation] = useState<StopRequest | null>(null);

  // 进度与产出共用本会话同一条任务总览投影（按可见性门控轮询）。
  const items = useTaskOverview({
    enabled: active && !!conversationId,
    ...(conversationId ? { conversationId } : {}),
  });
  const overviewItem = useMemo(
    () => (conversationId ? selectConversationTaskOverviewItem(items, conversationId) : null),
    [conversationId, items],
  );
  const artifactProjection = useMemo<TaskArtifactProjection>(() => {
    const empty: TaskArtifactProjection = {
      groups: [], summary: '', total: 0, visibleTotal: 0, hiddenTotal: 0,
    };
    if (!overviewItem) return empty;
    try {
      return projectTaskOverviewArtifacts(overviewItem, expanded.artifacts ? Infinity : undefined);
    } catch {
      return empty;
    }
  }, [overviewItem, expanded.artifacts]);

  const runs = useMemo(
    () => projectTaskMonitorRuns(runsReader?.snapshot ?? null, conversationId, isZh),
    [runsReader?.snapshot, conversationId, isZh],
  );

  const selectedRun: ManagedShellTask | null = useMemo(() => {
    if (!selectedRunId || !runsReader?.snapshot || !runs.some((row) => row.taskId === selectedRunId)) return null;
    return runsReader.snapshot.find((task) => task.taskId === selectedRunId) ?? null;
  }, [selectedRunId, runsReader?.snapshot, runs]);

  useEffect(() => {
    setSelectedRunId(null);
    setConfirmation(null);
  }, [conversationId]);

  useEffect(() => {
    if (!selectedRun) return;
    setConfirmation((current) => reconcileStopRequest(current, [selectedRun]));
  }, [selectedRun]);

  const stops = runsReader?.stops ?? null;
  // 两段式合并：本地确认态优先，其次 stops 链路自身的请求态。
  const runRequest: StopRequest | null = confirmation
    ?? (selectedRun ? stops?.requests[selectedRun.taskId] ?? null : null);
  const stopSelectedRun = () => {
    if (!selectedRun || selectedRun.status !== 'running' || confirmation?.taskId !== selectedRun.taskId) return;
    setConfirmation(null);
    void stops?.stop(selectedRun.taskId);
  };


  return (
    <aside
      className={`task-monitor-rail ${exiting ? 'motion-exit-slide-inline' : 'motion-enter-slide-inline'}`}
      aria-label={isZh ? '任务监控卡片' : 'Task monitor card'}
      aria-hidden={exiting}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && event.animationName === 'motion-exit-slide-inline') onAnimationEnd();
      }}
    >
      <div className="task-monitor-card" onAnimationEnd={(event) => {
        // Narrow overlay animates the glass itself so its parent cannot clip backdrop sampling.
        if (event.target === event.currentTarget && event.animationName === 'motion-exit-slide-inline') onAnimationEnd();
      }}>
        <header className="task-monitor-header">
          <span>{isZh ? '任务信息' : 'Task information'}</span>
          <button
            type="button"
            className="task-monitor-close"
            aria-label={isZh ? '收起任务监控卡片' : 'Close task monitor'}
            onClick={onClose}
          >
            <svg {...ICON_PROPS}><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </header>
        <div className="task-monitor-scroll">
          <MonitorSection title={isZh ? '产出' : 'Outputs'}>
            {artifactProjection.total ? artifactProjection.groups.map((group) => group.artifacts.map((artifact) => (
              <MonitorRow key={`${group.kind}:${artifact.ref}`} icon={<ArtifactIcon kind={group.kind} />}
                value={artifact.label} detail={artifact.openPath ?? artifact.label}
                onClick={artifact.openPath ? () => workbench?.openFile(artifact.openPath!) : undefined} />
            ))) : <p className="task-monitor-empty">{isZh ? '暂无产出' : 'No outputs yet'}</p>}
            {moreButton('artifacts', artifactProjection.total,
              artifactProjection.groups.reduce((sum, group) => sum + Math.min(MAX_VISIBLE_ARTIFACTS_PER_KIND, group.total), 0))}
          </MonitorSection>

          <MonitorSection title={isZh ? '来源与工具' : 'Sources & tools'}>
            {sources.length ? sources.slice(0, expanded.sources ? undefined : 4).map((source) => (
              <MonitorRow key={source.id} value={source.label}
                icon={source.kind === 'web' ? <GlobeIcon /> : source.kind === 'tool' ? <HammerIcon /> : <FolderIcon />}
                detail={source.kind === 'web' ? source.url : source.kind === 'file' ? source.path : source.label}
                onClick={() => openSource(source)} />
            )) : <p className="task-monitor-empty">{isZh ? '暂无来源或工具记录' : 'No sources or tool records yet'}</p>}
            {moreButton('sources', sources.length, 4)}
            {selectedSource && sourceMessage ? <div className="task-monitor-source-detail">
              <strong>{selectedSource.label}</strong>
              {selectedCall?.type === 'tool-call' ? <>
                <pre>{JSON.stringify(selectedCall.args ?? {}, null, 2)}</pre>
                <pre>{selectedCall.result || (isZh ? '暂无返回结果' : 'No result yet')}</pre>
              </> : selectedAttachment ? <>
                <p>{selectedAttachment.name} · {selectedAttachment.mimeType} · {selectedAttachment.size} B</p>
                {selectedAttachment.text ? <pre>{selectedAttachment.text}</pre>
                  : selectedAttachment.kind === 'image' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(selectedAttachment.dataUrl ?? '')
                    ? <img src={selectedAttachment.dataUrl} alt={selectedAttachment.name} style={{ maxWidth: '100%' }} />
                    : <p>{isZh ? '此附件没有可直接预览的内容，请在原消息中查看。' : 'No inline preview is available; see the original message.'}</p>}
              </> : null}
            </div> : null}
          </MonitorSection>

          {overviewItem?.planProgress ? (
            <button type="button" className="task-monitor-more" title={taskMonitorProgressHeadline(overviewItem)}
              onClick={() => { workbench?.setActiveTab('plan'); workbench?.setOpen(true); }}>
              {isZh ? '查看计划' : 'View plan'} · {overviewItem.planProgress.completed} / {overviewItem.planProgress.total}
            </button>
          ) : null}

          {runs.length > 0 ? (
            <MonitorSection title={isZh ? '后台任务' : 'Background tasks'}>
              {runs.slice(0, expanded.runs ? undefined : 2).map((row) => (
                <MonitorRow
                  key={row.taskId}
                  icon={<TerminalIcon />}
                  label={row.statusLabel}
                  value={row.cwdLabel ? `${row.command} · ${row.cwdLabel}` : row.command}
                  detail={`${row.command} · ${row.statusLabel}`}
                  onClick={() => {
                    setSelectedRunId((current) => (current === row.taskId ? null : row.taskId));
                  }}
                />
              ))}
              {moreButton('runs', runs.length, 2)}
              {selectedRun ? (
                <div className="task-monitor-run-details">
                  <BackgroundRunDetails
                    key={selectedRun.taskId}
                    task={selectedRun}
                    sources={runsReader?.sources ?? null}
                    isZh={isZh}
                    request={runRequest}
                    onConfirm={() => setConfirmation({ taskId: selectedRun.taskId, phase: 'confirm' })}
                    onCancel={() => setConfirmation(null)}
                    onStop={stopSelectedRun}
                  />
                </div>
              ) : null}
            </MonitorSection>
          ) : null}

          <MonitorSection title={isZh ? '环境' : 'Environment'}>
            <button type="button" className="task-monitor-environment-summary" aria-expanded={!!expanded.environment}
              onClick={() => setExpanded((current) => ({ ...current, environment: !current.environment }))}>
              {environment.find((row) => row.id === 'workspace')?.value || (isZh ? '未选择工作目录' : 'No workspace')}
              {currentHead ? ` · ${currentHead}` : ''}
            </button>
            {expanded.environment ? <>
              {environment.map((row) => <MonitorRow key={row.id}
                icon={row.icon === 'branch' ? <BranchIcon /> : row.icon === 'folder' ? <FolderIcon /> : <DeviceIcon />}
                label={row.label} value={row.value} detail={row.detail ?? row.value} />)}
              {workspaceIsGit ? <MonitorRow icon={<CheckIcon />} label={isZh ? '当前任务隔离' : 'Current task isolation'}
                value={currentIsolation === null ? (isZh ? '尚未确认' : 'Not confirmed')
                  : currentIsolation ? 'Worktree' : (isZh ? '当前目录' : 'Current directory')} /> : null}
              {workspaceIsGit && onSelectEnv ? <button type="button" className="task-monitor-more" aria-expanded={!!expanded.settings}
                onClick={() => setExpanded((current) => ({ ...current, settings: !current.settings }))}>
                {isZh ? '环境设置' : 'Environment settings'}
              </button> : null}
              {workspaceIsGit && expanded.settings && onSelectEnv ? <div className="task-monitor-environment-settings">
                {sourceBranch ? <div className="task-monitor-setting">
                  <span>{isZh ? '起始分支' : 'Starting branch'}</span>
                  <Dropdown className="task-monitor-env-dropdown" value={sourceBranch} options={sourceOptions}
                    onChange={onSelectEnv} disabled={!canSelectSource} triggerLabel={sourceBranch}
                    ariaLabel={isZh ? '起始分支' : 'Starting branch'}
                    title={isZh ? '选择下次任务的起始分支，不切换当前工作目录' : 'Starting branch for the next task; does not switch the current directory'}
                    searchable={canSelectSource} searchPlaceholder={isZh ? '搜索分支…' : 'Search branches…'}
                    tabs={canSelectSource ? [{ id: 'local', label: isZh ? '本地' : 'Local' }, { id: 'remote', label: isZh ? '远程' : 'Remote' }] : undefined}
                    tabsAriaLabel={isZh ? '分支范围' : 'Branch scope'}
                    emptyLabel={isZh ? '没有匹配的分支' : 'No matching branch'}
                    footerAction={canSelectSource && onCreateBranch ? { label: isZh ? '创建分支' : 'Create branch', onSelect: onCreateBranch } : undefined} />
                </div> : null}
                {isolationValue && isolationOptions.length ? <div className="task-monitor-setting">
                  <span>{isZh ? '下次任务隔离' : 'Next task isolation'}</span>
                  <Dropdown className="task-monitor-env-dropdown" value={isolationValue} options={isolationOptions}
                    onChange={onSelectEnv} disabled={!canChangeIsolation}
                    ariaLabel={isZh ? 'Worktree 隔离' : 'Worktree isolation'}
                    title={canChangeIsolation ? (isZh ? '下次任务是否写入独立 Worktree' : 'Use an isolated worktree for the next task')
                      : (isZh ? '任务执行期间不可更改' : 'Unavailable while a task is running')} />
                </div> : null}
              </div> : null}
            </> : null}
          </MonitorSection>
        </div>
      </div>
    </aside>
  );
}

// 保留投影函数的命名导出引用（测试与潜在复用方直接从 taskMonitorRail.ts 导入）。
export { projectTaskMonitorArtifacts };
