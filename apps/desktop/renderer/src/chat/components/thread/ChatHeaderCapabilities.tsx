import type { I18nRuntime } from '@peer-agent/i18n';
import type {
  CapabilityManifest,
  CapabilityHealth,
  LocalAccessLevel,
  SkillSummary,
} from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientApi } from '../../../clientApi';

type StatusTone = 'available' | 'needsAuth' | 'disabled' | 'unavailable';

interface CapabilityRow {
  readonly id: string;
  readonly name: string;
  readonly tone: StatusTone;
}

interface CapabilityGroup {
  readonly key: 'skill' | 'mcp' | 'plugin' | 'builtin';
  readonly labelKey:
    | 'header.capabilities.group.skill'
    | 'header.capabilities.group.mcp'
    | 'header.capabilities.group.plugin'
    | 'header.capabilities.group.builtin';
  readonly rows: readonly CapabilityRow[];
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
  const anchorRef = useRef<HTMLDivElement | null>(null);

  // 实时拉取能力与技能；失败静默兜底为空态。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [caps, sks] = await Promise.all([
          clientApi.listCapabilities(),
          clientApi.listSkills(),
        ]);
        if (!cancelled) {
          setCapabilities(caps);
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
    for (const cap of capabilities) {
      const row: CapabilityRow = {
        id: cap.capabilityId,
        name: i18n.capabilityName(cap),
        tone: healthToTone(cap.health, localAccessLevel),
      };
      if (cap.source === 'mcp') {
        mcpRows.push(row);
      } else if (cap.source === 'plugin') {
        pluginRows.push(row);
      } else {
        builtinRows.push(row);
      }
    }
    return [
      { key: 'skill', labelKey: 'header.capabilities.group.skill', rows: skillRows },
      { key: 'mcp', labelKey: 'header.capabilities.group.mcp', rows: mcpRows },
      { key: 'plugin', labelKey: 'header.capabilities.group.plugin', rows: pluginRows },
      { key: 'builtin', labelKey: 'header.capabilities.group.builtin', rows: builtinRows },
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
                {group.rows.map((row) => (
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
