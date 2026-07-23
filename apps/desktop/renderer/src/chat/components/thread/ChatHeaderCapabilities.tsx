import type { I18nRuntime } from '@peer-agent/i18n';
import type {
  CapabilityManifest,
  CapabilityHealth,
  LocalAccessLevel,
  SkillSummary,
} from '@peer-agent/protocol';
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientApi } from '../../../clientApi';

type StatusTone = 'available' | 'needsAuth' | 'disabled' | 'unavailable';

interface CapabilityRow {
  readonly id: string;
  readonly name: string;
  readonly tone: StatusTone;
}

/**
 * 服务节点：把同一来源（如同一个 MCP server）的多个工具聚合成一个可折叠节点，
 * 默认折叠，仅显示服务名 + 工具数 + 聚合状态点，点击才展开工具列表，节省纵向空间。
 */
interface CapabilityService {
  readonly id: string;
  readonly name: string;
  readonly tone: StatusTone;
  readonly rows: readonly CapabilityRow[];
}

type BuiltinGroupLabelKey =
  | 'header.capabilities.builtin.localExecution'
  | 'header.capabilities.builtin.browserControl'
  | 'header.capabilities.builtin.webAccess';

interface BuiltinCapabilityGroup {
  readonly key: 'localExecution' | 'browserControl' | 'webAccess';
  readonly labelKey: BuiltinGroupLabelKey;
  readonly rows: readonly CapabilityRow[];
}

interface CapabilityGroup {
  readonly key: 'skill' | 'mcp' | 'plugin' | 'builtin';
  readonly labelKey:
    | 'header.capabilities.group.skill'
    | 'header.capabilities.group.mcp'
    | 'header.capabilities.group.plugin'
    | 'header.capabilities.group.builtin';
  readonly rows: readonly CapabilityRow[];
  /**
   * 可选的服务聚合层（仅 MCP 分组使用）。存在时浮层渲染「服务 → 工具」两级，
   * rows 仍保留全部工具用于计数/兜底。
   */
  readonly services?: readonly CapabilityService[];
  /** 内置能力按用途分组；仅改变展示层，不改变 manifest、状态或执行入口。 */
  readonly builtinGroups?: readonly BuiltinCapabilityGroup[];
}

/**
 * 聚合多行状态为服务节点的代表状态：取「最需要关注」的一个，
 * 优先级 unavailable > disabled > needsAuth > available。
 */
function aggregateTone(rows: readonly CapabilityRow[]): StatusTone {
  let result: StatusTone = 'available';
  const rank: Record<StatusTone, number> = {
    available: 0,
    needsAuth: 1,
    disabled: 2,
    unavailable: 3,
  };
  for (const row of rows) {
    if (rank[row.tone] > rank[result]) result = row.tone;
  }
  return result;
}

const STATUS_KEY: Record<StatusTone,
  | 'header.capabilities.status.available'
  | 'header.capabilities.status.needsAuth'
  | 'header.capabilities.status.disabled'
  | 'header.capabilities.status.unavailable'> = {
  available: 'header.capabilities.status.available',
  needsAuth: 'header.capabilities.status.needsAuth',
  disabled: 'header.capabilities.status.disabled',
  unavailable: 'header.capabilities.status.unavailable',
};

/**
 * healthToTone —— 把能力的静态健康度（manifest 里写死的 health）结合「当前本地访问级别」
 * 映射成 UI 状态点。
 *
 * 关键修正：manifest 的 `needs_permission` 只是「默认风险」声明，并不代表用户当前缺权限。
 * 真正的权限闸门在主进程 PermissionGate：当 accessLevel === 'full_local'（完全访问）时，
 * 这类能力会被自动放行、调用时不弹窗（见 permission-gate.mjs 的 maybeCreateAutoGrantFor*）。
 * 因此在 full_local 下应显示为「可用」，避免误导用户以为缺权限/会被拦截；
 * 其它访问级别下仍标 `needsAuth`，但文案表达的是「调用前询问」而非「缺权限」。
 */
function healthToTone(health: CapabilityHealth, accessLevel: LocalAccessLevel): StatusTone {
  switch (health) {
    case 'available':
      return 'available';
    case 'needs_permission':
      // full_local 自动放行，不弹窗 → 视为可用；其它级别调用前会询问。
      return accessLevel === 'full_local' ? 'available' : 'needsAuth';
    case 'policy_disabled':
    case 'local_disabled':
      return 'disabled';
    case 'unhealthy':
    default:
      return 'unavailable';
  }
}

/**
 * ChatHeaderCapabilities — 头部「已挂载能力」指示器。
 *
 * 以一个能力 pill 展示已挂载能力总数，点击弹出按 技能(Skill)/MCP/插件(Plugin)/内置
 * 分组的浮层，每项显示名称与状态点，底部提供「管理」入口跳转设置。
 * 数据取自 listCapabilities() + listSkills() 实时接口；加载失败静默兜底为空态。
 */
export function ChatHeaderCapabilities({
  i18n,
  localAccessLevel,
  onOpenSettings,
}: {
  readonly i18n: I18nRuntime;
  readonly localAccessLevel: LocalAccessLevel;
  readonly onOpenSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<readonly CapabilityManifest[]>([]);
  const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
  // 默认折叠二级入口，仅在用户选择服务或内置分组后展示具体能力。
  const [expandedServices, setExpandedServices] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedBuiltinGroups, setExpandedBuiltinGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const anchorRef = useRef<HTMLDivElement | null>(null);

  const toggleExpandedItem = useCallback(
    (
      itemId: string,
      setItems: Dispatch<SetStateAction<ReadonlySet<string>>>,
    ) => {
      setItems((prev) => {
        const next = new Set(prev);
        if (next.has(itemId)) next.delete(itemId);
        else next.add(itemId);
        return next;
      });
    },
    [],
  );

  // 实时拉取能力与技能；失败静默兜底为空态。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [caps, mcpCaps, sks] = await Promise.all([
          clientApi.listCapabilities(),
          // MCP 动态能力（source:'mcp'）来自独立 IPC，需并入后 MCP 分组才会出现。
          clientApi.mcpListCapabilities().catch(() => [] as readonly CapabilityManifest[]),
          clientApi.listSkills(),
        ]);
        if (!cancelled) {
          // 按 capabilityId 去重合并（静态清单优先，避免与 MCP 同 id 项重复）。
          const seen = new Set<string>();
          const merged: CapabilityManifest[] = [];
          for (const cap of [...caps, ...mcpCaps]) {
            if (seen.has(cap.capabilityId)) continue;
            seen.add(cap.capabilityId);
            merged.push(cap);
          }
          setCapabilities(merged);
          setSkills(sks);
        }
      } catch {
        if (!cancelled) {
          setCapabilities([]);
          setSkills([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 点击浮层外部时关闭。
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const groups = useMemo<readonly CapabilityGroup[]>(() => {
    const skillRows: CapabilityRow[] = skills.map((skill) => ({
      id: skill.skillId,
      name: skill.name,
      tone: skill.enabled ? 'available' : 'disabled',
    }));
    const mcpRows: CapabilityRow[] = [];
    const pluginRows: CapabilityRow[] = [];
    const builtinRows: CapabilityRow[] = [];
    // 按服务（providerId）聚合 MCP 工具，保持首次出现顺序。
    const mcpServiceOrder: string[] = [];
    const mcpServiceMap = new Map<string, { label: string; rows: CapabilityRow[] }>();
    for (const cap of capabilities) {
      const row: CapabilityRow = {
        id: cap.capabilityId,
        name: i18n.capabilityName(cap),
        tone: healthToTone(cap.health, localAccessLevel),
      };
      if (cap.source === 'mcp') {
        mcpRows.push(row);
        // providerId 缺失时退化为「每工具一个服务」，至少不丢失条目。
        const serviceId = cap.providerId ?? cap.capabilityId;
        const serviceLabel = cap.providerLabel ?? row.name;
        let bucket = mcpServiceMap.get(serviceId);
        if (!bucket) {
          bucket = { label: serviceLabel, rows: [] };
          mcpServiceMap.set(serviceId, bucket);
          mcpServiceOrder.push(serviceId);
        }
        bucket.rows.push(row);
      } else if (cap.source === 'plugin') {
        pluginRows.push(row);
      } else {
        builtinRows.push(row);
      }
    }
    const mcpServices: CapabilityService[] = mcpServiceOrder.map((serviceId) => {
      const bucket = mcpServiceMap.get(serviceId)!;
      return {
        id: serviceId,
        name: bucket.label,
        tone: aggregateTone(bucket.rows),
        rows: bucket.rows,
      };
    });
    const builtinGroups = ([
      {
        key: 'localExecution',
        labelKey: 'header.capabilities.builtin.localExecution',
        rows: builtinRows.filter((row) => row.id.startsWith('local.shell.')),
      },
      {
        key: 'browserControl',
        labelKey: 'header.capabilities.builtin.browserControl',
        rows: builtinRows.filter((row) => row.id.startsWith('local.web.control.')),
      },
      {
        key: 'webAccess',
        labelKey: 'header.capabilities.builtin.webAccess',
        rows: builtinRows.filter(
          (row) => !row.id.startsWith('local.shell.') && !row.id.startsWith('local.web.control.'),
        ),
      },
    ] satisfies BuiltinCapabilityGroup[]).filter((group) => group.rows.length > 0);
    return [
      { key: 'skill', labelKey: 'header.capabilities.group.skill', rows: skillRows },
      { key: 'mcp', labelKey: 'header.capabilities.group.mcp', rows: mcpRows, services: mcpServices },
      { key: 'plugin', labelKey: 'header.capabilities.group.plugin', rows: pluginRows },
      {
        key: 'builtin',
        labelKey: 'header.capabilities.group.builtin',
        rows: builtinRows,
        builtinGroups,
      },
    ];
  }, [capabilities, skills, i18n, localAccessLevel]);

  const total = capabilities.length + skills.length;
  const nonEmptyGroups = groups.filter((group) => group.rows.length > 0);

  const handleManage = useCallback(() => {
    setOpen(false);
    onOpenSettings?.();
  }, [onOpenSettings]);

  return (
    <div className="chat-header-cap-anchor" ref={anchorRef}>
      <button
        type="button"
        className={`chat-header-cap-pill ${open ? 'active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={i18n.t('header.capabilities.aria', { count: total })}
        title={i18n.t('header.capabilities.title')}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m12 3 8.5 5v8L12 21l-8.5-5V8Z" />
          <path d="M12 12 3.5 8" />
          <path d="m12 12 8.5-4" />
          <path d="M12 12v9" />
        </svg>
        <span className="chat-header-cap-count">{total}</span>
      </button>
      {open ? (
        <div className="chat-header-cap-popover" role="menu">
          <div className="chat-header-cap-popover-title">
            {i18n.t('header.capabilities.title')}
          </div>
          {nonEmptyGroups.length === 0 ? (
            <div className="chat-header-cap-empty">{i18n.t('header.capabilities.empty')}</div>
          ) : (
            nonEmptyGroups.map((group) => (
              <div className="chat-header-cap-group" key={group.key}>
                <div className="chat-header-cap-group-head">
                  <span className="chat-header-cap-group-name">{i18n.t(group.labelKey)}</span>
                  <span className="chat-header-cap-group-count">{group.rows.length}</span>
                </div>
                {group.services
                  ? group.services.map((service) => {
                      const isExpanded = expandedServices.has(service.id);
                      return (
                        <div className="chat-header-cap-service" key={`${group.key}:svc:${service.id}`}>
                          <button
                            type="button"
                            className="chat-header-cap-service-head"
                            aria-expanded={isExpanded}
                            onClick={() => toggleExpandedItem(service.id, setExpandedServices)}
                          >
                            <svg
                              className={`chat-header-cap-service-caret${isExpanded ? ' expanded' : ''}`}
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="m9 18 6-6-6-6" />
                            </svg>
                            <span className={`chat-header-cap-dot tone-${service.tone}`} aria-hidden="true" />
                            <span className="chat-header-cap-service-name" title={service.name}>
                              {service.name}
                            </span>
                            <span className="chat-header-cap-service-count">
                              {i18n.t('header.capabilities.toolCount', { count: service.rows.length })}
                            </span>
                          </button>
                          {isExpanded ? (
                            <div className="chat-header-cap-service-tools">
                              {service.rows.map((row) => (
                                <div className="chat-header-cap-item" key={`${group.key}:${row.id}`}>
                                  <span className={`chat-header-cap-dot tone-${row.tone}`} aria-hidden="true" />
                                  <span className="chat-header-cap-item-name" title={row.name}>
                                    {row.name}
                                  </span>
                                  <span className="chat-header-cap-item-status">
                                    {i18n.t(STATUS_KEY[row.tone])}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  : group.builtinGroups
                    ? group.builtinGroups.map((builtinGroup) => {
                        const isExpanded = expandedBuiltinGroups.has(builtinGroup.key);
                        return (
                          <div className="chat-header-cap-builtin-group" key={builtinGroup.key}>
                            <button
                              type="button"
                              className="chat-header-cap-builtin-head"
                              aria-expanded={isExpanded}
                              onClick={() =>
                                toggleExpandedItem(builtinGroup.key, setExpandedBuiltinGroups)
                              }
                            >
                              <svg
                                className={`chat-header-cap-service-caret${isExpanded ? ' expanded' : ''}`}
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="m9 18 6-6-6-6" />
                              </svg>
                              <span className="chat-header-cap-service-name">
                                {i18n.t(builtinGroup.labelKey)}
                              </span>
                              <span className="chat-header-cap-service-count">
                                {builtinGroup.rows.length}
                              </span>
                            </button>
                            {isExpanded ? (
                              <div className="chat-header-cap-service-tools">
                                {builtinGroup.rows.map((row) => (
                                  <div className="chat-header-cap-item" key={`${group.key}:${row.id}`}>
                                    <span className={`chat-header-cap-dot tone-${row.tone}`} aria-hidden="true" />
                                    <span className="chat-header-cap-item-name" title={row.name}>
                                      {row.name}
                                    </span>
                                    <span className="chat-header-cap-item-status">
                                      {i18n.t(STATUS_KEY[row.tone])}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        );
                      })
                    : group.rows.map((row) => (
                        <div className="chat-header-cap-item" key={`${group.key}:${row.id}`}>
                          <span className={`chat-header-cap-dot tone-${row.tone}`} aria-hidden="true" />
                          <span className="chat-header-cap-item-name" title={row.name}>
                            {row.name}
                          </span>
                          <span className="chat-header-cap-item-status">
                            {i18n.t(STATUS_KEY[row.tone])}
                          </span>
                        </div>
                      ))}
              </div>
            ))
          )}
          {onOpenSettings ? (
            <button type="button" className="chat-header-cap-manage" onClick={handleManage}>
              <span>{i18n.t('header.capabilities.manage')}</span>
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
