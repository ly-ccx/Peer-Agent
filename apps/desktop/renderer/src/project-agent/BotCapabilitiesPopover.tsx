import type { I18nRuntime } from '@peer-agent/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { Switch } from '../ui/boolean-controls/Switch';
import { PeerIcon } from '../ui/icons';
import type { BotCapabilitiesState, BotMountedMcpItem } from './state/useBotCapabilities';
import './styles/bot-capabilities.css';

interface BotCapabilitiesButtonProps {
  readonly mode: 'bot' | 'inherited';
  readonly botName: string;
  readonly readOnlyTask?: boolean;
  readonly capabilities: BotCapabilitiesState;
  readonly i18n: I18nRuntime;
  readonly onOpenDrawerCapabilities?: () => void;
  readonly onOpenGlobalPlugins?: () => void;
  readonly onAdjustOnBot?: () => void;
}

function McpServiceRow({
  server,
  readOnly,
  saving,
  i18n,
  onToggle,
}: {
  readonly server: BotMountedMcpItem;
  readonly readOnly: boolean;
  readonly saving: boolean;
  readonly i18n: I18nRuntime;
  readonly onToggle?: (next: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleTools = server.tools.filter((tool) => tool.visible);
  const unhealthy = server.healthStatus === 'failed';
  const untrusted = !server.trusted;
  const muted = !server.effectiveEnabled || unhealthy || untrusted;

  return (
    <div className={`bot-cap-row-wrap${muted ? ' is-muted' : ''}`}>
      <div className="bot-cap-row">
        <div className="bot-cap-row-main">
          <div className="bot-cap-row-title-line">
            <span className="bot-cap-row-name" title={server.name}>{server.name}</span>
            <span className="bot-cap-tag">
              {i18n.t('projectAgent.capabilities.toolsCount', { count: server.visibleToolsCount })}
            </span>
            {unhealthy ? (
              <span className="bot-cap-tag is-warn">{i18n.t('projectAgent.capabilities.badge.unhealthy')}</span>
            ) : null}
            {untrusted ? (
              <span className="bot-cap-tag is-warn">{i18n.t('projectAgent.capabilities.badge.untrusted')}</span>
            ) : null}
            {!readOnly && server.overridden ? (
              <span className={`bot-cap-tag${server.effectiveEnabled ? ' is-accent' : ''}`}>
                {i18n.t(
                  server.effectiveEnabled
                    ? 'projectAgent.capabilities.badge.overrideOn'
                    : 'projectAgent.capabilities.badge.overrideOff',
                )}
              </span>
            ) : !readOnly && !server.defaultEnabled ? (
              <span className="bot-cap-tag">{i18n.t('projectAgent.capabilities.badge.globalOff')}</span>
            ) : null}
          </div>
          {server.description ? (
            <p className="bot-cap-row-desc" title={server.description}>{server.description}</p>
          ) : null}
        </div>
        <div className="bot-cap-row-actions">
          {visibleTools.length > 0 ? (
            <button
              type="button"
              className="bot-cap-expand-btn"
              aria-expanded={expanded}
              aria-label={server.name}
              onClick={() => setExpanded((v) => !v)}
            >
              <PeerIcon name={expanded ? 'chevronUp' : 'chevronDown'} size={14} />
            </button>
          ) : null}
          {!readOnly && onToggle ? (
            <Switch
              checked={server.effectiveEnabled}
              disabled={saving}
              aria-label={server.name}
              onCheckedChange={onToggle}
            />
          ) : null}
        </div>
      </div>
      {expanded && visibleTools.length > 0 ? (
        <ul className="bot-cap-tool-list">
          {visibleTools.map((tool) => (
            <li key={tool.name} className="bot-cap-tool-item">
              <code>{tool.name}</code>
              {tool.description ? <span>{tool.description}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function BotCapabilitiesButton({
  mode,
  botName,
  readOnlyTask = false,
  capabilities,
  i18n,
  onOpenDrawerCapabilities,
  onOpenGlobalPlugins,
  onAdjustOnBot,
}: BotCapabilitiesButtonProps) {
  const [open, setOpen] = useState(false);
  const [builtinOpen, setBuiltinOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const isInherited = mode === 'inherited';

  useEffect(() => {
    if (!open) return undefined;
    void capabilities.refresh();
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, capabilities.refresh]);

  const mountedSkills = capabilities.skills.filter((item) => item.effectiveEnabled);
  const mountedMcps = capabilities.mcps.filter(
    (item) => item.effectiveEnabled && item.trusted && item.healthStatus !== 'failed',
  );
  const displaySkills = isInherited ? mountedSkills : capabilities.skills;
  const displayMcps = isInherited ? mountedMcps : capabilities.mcps;
  const count = capabilities.mountedTotalCount;

  const triggerTitle = isInherited
    ? i18n.t('projectAgent.capabilities.inheritedTrigger', { bot: botName })
    : count > 0
      ? i18n.t('projectAgent.capabilities.triggerCount', { count })
      : i18n.t('projectAgent.capabilities.trigger');

  return (
    <div className="bot-cap-anchor" ref={anchorRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`bot-profile bot-cap-trigger${count === 0 && !isInherited ? ' is-icon' : ''}${isInherited ? ' is-inherited' : ''}`}
        aria-label={triggerTitle}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-haspopup="dialog"
        title={triggerTitle}
        onClick={() => setOpen((current) => !current)}
      >
        <PeerIcon name="agentFacet" size={16} strokeWidth={1.75} />
        {count > 0 ? <span className="bot-cap-trigger-count">{count}</span> : null}
        {!isInherited && capabilities.hasOverrides ? (
          <span className="bot-cap-override-dot" aria-hidden="true" />
        ) : null}
      </button>

      {open ? (
        <div
          id={popoverId}
          className="bot-cap-popover"
          role="dialog"
          aria-label={isInherited
            ? i18n.t('projectAgent.capabilities.inheritedTitle', { bot: botName })
            : i18n.t('projectAgent.capabilities.title')}
        >
          <header className="bot-cap-popover-head">
            <div className="bot-cap-popover-head-copy">
              <strong>
                {isInherited
                  ? i18n.t('projectAgent.capabilities.inheritedTitle', { bot: botName })
                  : i18n.t('projectAgent.capabilities.title')}
              </strong>
              <p>
                {isInherited
                  ? i18n.t('projectAgent.capabilities.inheritedSubtitle')
                  : i18n.t('projectAgent.capabilities.subtitle')}
              </p>
            </div>
            {!isInherited && capabilities.hasOverrides ? (
              <button
                type="button"
                className="bot-cap-text-btn"
                disabled={capabilities.saving}
                onClick={() => { void capabilities.resetOverrides(); }}
              >
                {i18n.t('projectAgent.capabilities.resetGlobal')}
              </button>
            ) : null}
          </header>

          {isInherited && readOnlyTask ? (
            <p className="bot-cap-banner" role="note">
              <PeerIcon name="info" size={14} />
              <span>{i18n.t('projectAgent.capabilities.inheritedReadOnlyHint')}</span>
            </p>
          ) : null}

          {capabilities.error ? (
            <p className="bot-cap-error" role="alert">
              {i18n.t('projectAgent.capabilities.saveFailed')}
            </p>
          ) : null}

          <div className="bot-cap-popover-body">
            {capabilities.loading && displaySkills.length === 0 && displayMcps.length === 0 ? (
              <p className="bot-cap-empty">{i18n.t('projectAgent.capabilities.loading')}</p>
            ) : isInherited && displaySkills.length === 0 && displayMcps.length === 0 ? (
              <p className="bot-cap-empty">{i18n.t('projectAgent.capabilities.empty.inherited')}</p>
            ) : (
              <>
                <section className="bot-cap-group">
                  <div className="bot-cap-group-head">
                    <span>{i18n.t('projectAgent.capabilities.group.skills')}</span>
                    <span className="bot-cap-group-count">
                      {isInherited
                        ? `${mountedSkills.length}`
                        : `${capabilities.mountedSkillCount}/${capabilities.skills.length}`}
                    </span>
                  </div>
                  {displaySkills.length === 0 ? (
                    <p className="bot-cap-empty">{i18n.t('projectAgent.capabilities.empty.skills')}</p>
                  ) : (
                    <div className="bot-cap-list">
                      {displaySkills.map((skill) => (
                        <div
                          key={skill.skillId}
                          className={`bot-cap-row${!skill.effectiveEnabled ? ' is-muted' : ''}`}
                        >
                          <div className="bot-cap-row-main">
                            <div className="bot-cap-row-title-line">
                              <span className="bot-cap-row-name" title={skill.name}>{skill.name}</span>
                              {skill.scope === 'workspace' ? (
                                <span className="bot-cap-tag">
                                  {i18n.t('projectAgent.capabilities.badge.workspace')}
                                </span>
                              ) : null}
                              {!isInherited && skill.overridden ? (
                                <span className={`bot-cap-tag${skill.effectiveEnabled ? ' is-accent' : ''}`}>
                                  {i18n.t(
                                    skill.effectiveEnabled
                                      ? 'projectAgent.capabilities.badge.overrideOn'
                                      : 'projectAgent.capabilities.badge.overrideOff',
                                  )}
                                </span>
                              ) : !isInherited && !skill.defaultEnabled ? (
                                <span className="bot-cap-tag">
                                  {i18n.t('projectAgent.capabilities.badge.globalOff')}
                                </span>
                              ) : null}
                            </div>
                            {skill.description ? (
                              <p className="bot-cap-row-desc" title={skill.description}>{skill.description}</p>
                            ) : null}
                          </div>
                          {!isInherited ? (
                            <div className="bot-cap-row-actions">
                              <Switch
                                checked={skill.effectiveEnabled}
                                disabled={capabilities.saving}
                                aria-label={skill.name}
                                onCheckedChange={(next) => { void capabilities.toggleSkill(skill.skillId, next); }}
                              />
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="bot-cap-group">
                  <div className="bot-cap-group-head">
                    <span>{i18n.t('projectAgent.capabilities.group.mcp')}</span>
                    <span className="bot-cap-group-count">
                      {isInherited
                        ? `${mountedMcps.length}`
                        : `${capabilities.mountedMcpCount}/${capabilities.mcps.length}`}
                    </span>
                  </div>
                  {displayMcps.length === 0 ? (
                    <p className="bot-cap-empty">{i18n.t('projectAgent.capabilities.empty.mcp')}</p>
                  ) : (
                    <div className="bot-cap-list">
                      {displayMcps.map((server) => (
                        <McpServiceRow
                          key={server.id}
                          server={server}
                          readOnly={isInherited}
                          saving={capabilities.saving}
                          i18n={i18n}
                          onToggle={(next) => { void capabilities.toggleMcp(server.id, next); }}
                        />
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}

            <section className="bot-cap-builtin-disclosure">
              <button
                type="button"
                className="bot-cap-builtin-toggle"
                aria-expanded={builtinOpen}
                onClick={() => setBuiltinOpen((v) => !v)}
              >
                <span>{i18n.t('projectAgent.capabilities.group.builtin')}</span>
                <PeerIcon name={builtinOpen ? 'chevronUp' : 'chevronDown'} size={14} />
              </button>
              {builtinOpen ? (
                <div className="bot-cap-builtin-body">
                  <p className="bot-cap-builtin-hint">{i18n.t('projectAgent.capabilities.builtinHint')}</p>
                  <div className="bot-cap-builtin-pills">
                    {capabilities.builtins.map((item) => (
                      <span key={item.key} className="bot-cap-builtin-pill">
                        {i18n.t(`projectAgent.capabilities.builtin.${item.key}`)}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          </div>

          <footer className="bot-cap-popover-foot">
            {isInherited ? (
              onAdjustOnBot ? (
                <button
                  type="button"
                  className="bot-cap-foot-btn is-primary"
                  onClick={() => {
                    setOpen(false);
                    onAdjustOnBot();
                  }}
                >
                  <span>{i18n.t('projectAgent.capabilities.adjustOnBot')}</span>
                  <PeerIcon name="arrowRight" size={14} />
                </button>
              ) : null
            ) : (
              <>
                {onOpenDrawerCapabilities ? (
                  <button
                    type="button"
                    className="bot-cap-foot-btn"
                    onClick={() => {
                      setOpen(false);
                      onOpenDrawerCapabilities();
                    }}
                  >
                    <span>{i18n.t('projectAgent.capabilities.openInDrawer')}</span>
                  </button>
                ) : null}
                {onOpenGlobalPlugins ? (
                  <button
                    type="button"
                    className="bot-cap-foot-btn"
                    onClick={() => {
                      setOpen(false);
                      onOpenGlobalPlugins();
                    }}
                  >
                    <span>{i18n.t('projectAgent.capabilities.manageGlobal')}</span>
                    <PeerIcon name="arrowUpRight" size={14} />
                  </button>
                ) : null}
              </>
            )}
          </footer>
        </div>
      ) : null}
    </div>
  );
}
