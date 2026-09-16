import { useEffect, useMemo, useState } from 'react';
import {
  projectTaskMonitorArtifacts,
  projectTaskMonitorEnvironment,
  projectTaskMonitorRuns,
  selectConversationTaskOverviewItem,
} from '../taskMonitorRail.ts';
import {
  projectTaskOverviewArtifacts,
  type TaskArtifactProjection,
} from '../../app/pages/taskOverviewArtifacts.ts';
import { useTaskOverview } from '../../app/hooks/useTaskOverview';
import { useBackgroundRunsContext } from '../GlobalBackgroundTasksButton';
import { BackgroundRunDetails } from '../BackgroundRunDetails';
import { useWorkbenchOptional } from '../WorkbenchContext';
import { reconcileStopRequest, type StopRequest } from '../backgroundRuntimeState.ts';
import type { ManagedShellTask, CapabilityManifest, SkillSummary } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';

/**
 * 任务监控卡片 —— 单张圆角卡片 + 内部分区标签（用户 2026-09-16 截图定稿）。
 *
 * 形态：一张浅底圆角卡片；内部按 环境信息 / 技能与 MCP / 产出 / 网页查阅 分区，
 * 每区一行「图标 + 文本」，底部「查看更多 (N)」。进度与后台任务合并进任务分区。
 *
 * 治理边界：
 * - 挂载与让位：由 ChatSurface 挂在 .chat-surface 内（见 chat-surface.css），本组件不管布局；
 * - 技能与 MCP 复用 listSkills + listCapabilities + mcpListCapabilities 同一 IPC 链路；
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

function MonitorRow({ icon, value, detail, onClick }: {
  readonly icon: React.ReactNode;
  readonly value: string;
  readonly detail?: string;
  readonly onClick?: () => void;
}) {
  const content = (
    <>
      <span className="task-monitor-row-icon">{icon}</span>
      <span className="task-monitor-row-value" title={detail ?? value}>{value}</span>
    </>
  );
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

export function TaskMonitorRailView({
  isZh,
  workspacePath,
  branch,
  workspaceIsGit,
  conversationId,
  active,
  onClose,
}: {
  readonly isZh: boolean;
  readonly workspacePath: string | null;
  readonly branch: string | null;
  readonly workspaceIsGit: boolean | null;
  readonly conversationId: string | null;
  /**
   * 本视图是否在当前 ChatSurface 内真正可见。
   *
   * 收起时仍保留组件状态，但必须显式门控 taskOverview，避免未打开监控栏时多挂一路
   * 轮询与广播订阅——那正是 useTaskOverview.performance.test.ts 在守的调用点成本。
   */
  readonly active: boolean;
  readonly onClose: () => void;
}) {
  const workbench = useWorkbenchOptional();
  // 复用 Provider 的单一轮询 reader，避免第二套 poller 重复打主进程。
  const runsReader = useBackgroundRunsContext();
  const environment = useMemo(
    () => projectTaskMonitorEnvironment(workspacePath, branch, workspaceIsGit, isZh),
    [branch, isZh, workspaceIsGit, workspacePath],
  );

  // 技能与 MCP：与 ChatHeaderCapabilities 同一 IPC 链路；失败静默为空。
  const [skillNames, setSkillNames] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const [caps, mcpCaps, sks] = await Promise.all([
          clientApi.listCapabilities(),
          clientApi.mcpListCapabilities().catch(() => [] as readonly CapabilityManifest[]),
          clientApi.listSkills(),
        ]);
        if (cancelled) return;
        const mcpNames = [...caps, ...mcpCaps]
          .filter((cap) => cap.source === 'mcp')
          .map((cap) => cap.capabilityId.split(/[./]/).pop() ?? cap.capabilityId);
        const names = new Set<string>([
          ...(sks as readonly SkillSummary[]).map((skill) => skill.name),
          ...mcpNames,
        ]);
        setSkillNames([...names].slice(0, 6));
      } catch {
        if (!cancelled) setSkillNames([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  // 网页查阅：当前会话的 browserSession tabs（url + title）。
  const webVisits = useMemo(() => {
    const tabs = workbench?.browserSession?.tabs ?? [];
    return tabs
      .filter((tab) => tab.url && !tab.url.startsWith('about:blank'))
      .slice(0, 4)
      .map((tab) => ({ key: tab.id, label: urlLabel(tab.url), url: tab.url, title: tab.title }));
  }, [workbench?.browserSession?.tabs]);

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
      return projectTaskOverviewArtifacts(overviewItem);
    } catch {
      return empty;
    }
  }, [overviewItem]);

  const runs = useMemo(
    () => projectTaskMonitorRuns(runsReader?.snapshot ?? null, conversationId, isZh),
    [runsReader?.snapshot, conversationId, isZh],
  );

  const selectedRun: ManagedShellTask | null = useMemo(() => {
    if (!selectedRunId || !runsReader?.snapshot) return null;
    return runsReader.snapshot.find((task) => task.taskId === selectedRunId) ?? null;
  }, [selectedRunId, runsReader?.snapshot]);

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

  // 各分区条目数（含被截断的隐藏项），用于底部「查看更多 (N)」。
  const hiddenTotal = artifactProjection.hiddenTotal
    + Math.max(0, runs.length - 2)
    + Math.max(0, (workbench?.browserSession?.tabs?.length ?? 0) - webVisits.length);

  return (
    <aside className="task-monitor-rail" aria-label={isZh ? '任务监控卡片' : 'Task monitor card'}>
      <div className="task-monitor-card">
        <header className="task-monitor-header">
          <span>{isZh ? '任务监控' : 'Task monitor'}</span>
          <span className="task-monitor-updated" aria-live="off">
            {isZh ? '实时' : 'Live'}
          </span>
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
          <MonitorSection title={isZh ? '环境信息' : 'Environment'}>
            {environment.map((row) => (
              <MonitorRow
                key={row.id}
                icon={row.icon === 'branch' ? <BranchIcon /> : row.icon === 'folder' ? <FolderIcon /> : <DeviceIcon />}
                value={row.value}
                detail={row.detail ?? row.value}
              />
            ))}
            {workspaceIsGit ? (
              <MonitorRow icon={<CheckIcon />} value={isZh ? '提交或推送' : 'Commit or push'} />
            ) : null}
          </MonitorSection>

          {skillNames.length > 0 ? (
            <MonitorSection title={isZh ? '技能与 MCP' : 'Skills & MCP'}>
              {skillNames.map((name) => (
                <MonitorRow key={name} icon={<HammerIcon />} value={name} />
              ))}
            </MonitorSection>
          ) : null}

          {overviewItem?.planProgress ? (
            <MonitorSection title={isZh ? '任务进度' : 'Progress'}>
              <div className="task-monitor-progress-row">
                <span>{overviewItem.statusLabel}</span>
                <strong>{overviewItem.planProgress.completed} / {overviewItem.planProgress.total}</strong>
              </div>
              <div
                className="task-monitor-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={overviewItem.planProgress.total}
                aria-valuenow={overviewItem.planProgress.completed}
              >
                <span style={{ width: `${overviewItem.planProgress.total > 0 ? Math.min(100, Math.max(0, (overviewItem.planProgress.completed / overviewItem.planProgress.total) * 100)) : 0}%` }} />
              </div>
            </MonitorSection>
          ) : null}

          {runs.length > 0 ? (
            <MonitorSection title={isZh ? '后台任务' : 'Background tasks'}>
              {runs.map((row) => (
                <MonitorRow
                  key={row.taskId}
                  icon={<TerminalIcon />}
                  value={row.cwdLabel ? `${row.command} · ${row.cwdLabel}` : row.command}
                  detail={row.command}
                  onClick={() => {
                    setSelectedRunId((current) => (current === row.taskId ? null : row.taskId));
                  }}
                />
              ))}
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

          {artifactProjection.total > 0 ? (
            <MonitorSection title={isZh ? '产出' : 'Outputs'}>
              {artifactProjection.groups.map((group) => (
                group.artifacts.map((artifact) => (
                  <MonitorRow
                    key={`${group.kind}:${artifact.ref}`}
                    icon={<ArtifactIcon kind={group.kind} />}
                    value={artifact.label}
                    detail={artifact.label}
                    {...(artifact.openPath
                      ? {
                          onClick: () => {
                            if (artifact.openPath?.startsWith('http')) {
                              void workbench?.openFile(artifact.openPath ?? '');
                            } else {
                              void workbench?.openFile(artifact.openPath ?? '');
                            }
                          },
                        }
                      : {})}
                  />
                ))
              ))}
            </MonitorSection>
          ) : null}

          {webVisits.length > 0 ? (
            <MonitorSection title={isZh ? '网页查阅' : 'Web access'}>
              {webVisits.map((visit) => (
                <MonitorRow
                  key={visit.key}
                  icon={<GlobeIcon />}
                  value={visit.label}
                  detail={visit.title || visit.url}
                  onClick={() => {
                    if (workbench) {
                      workbench.setActiveTab('browser');
                      workbench.setOpen(true);
                    }
                  }}
                />
              ))}
            </MonitorSection>
          ) : null}

          {hiddenTotal > 0 ? (
            <button
              type="button"
              className="task-monitor-more"
              onClick={() => {
                if (workbench) {
                  workbench.setActiveTab('documents');
                  workbench.setOpen(true);
                }
              }}
            >
              {isZh ? `查看更多 (${hiddenTotal})` : `View more (${hiddenTotal})`}
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

// 保留投影函数的命名导出引用（测试与潜在复用方直接从 taskMonitorRail.ts 导入）。
export { projectTaskMonitorArtifacts };
