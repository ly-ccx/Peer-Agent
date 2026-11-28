import type { I18nRuntime } from '@peer-agent/i18n';
import { useEffect, useState } from 'react';
import { Switch } from '../../ui/boolean-controls/Switch';
import { PeerIcon } from '../../ui/icons';
import { SettingsGroup } from '../../ui/settings/SettingsGroup';
import type { BotCapabilitiesState, BotMountedMcpItem } from '../state/useBotCapabilities';
import '../styles/bot-capabilities.css';

function DrawerMcpRow({
  server,
  saving,
  i18n,
  onToggle,
}: {
  readonly server: BotMountedMcpItem;
  readonly saving: boolean;
  readonly i18n: I18nRuntime;
  readonly onToggle: (next: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleTools = server.tools.filter((tool) => tool.visible);
  const unhealthy = server.healthStatus === 'failed';
  const untrusted = !server.trusted;
  const muted = !server.effectiveEnabled || unhealthy || untrusted;

  return (
    <div className={`bot-cap-drawer-item${muted ? ' is-muted' : ''}`}>
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
            {server.overridden ? (
              <span className={`bot-cap-tag${server.effectiveEnabled ? ' is-accent' : ''}`}>
                {i18n.t(
                  server.effectiveEnabled
                    ? 'projectAgent.capabilities.badge.overrideOn'
                    : 'projectAgent.capabilities.badge.overrideOff',
                )}
              </span>
            ) : !server.defaultEnabled ? (
              <span className="bot-cap-tag">{i18n.t('projectAgent.capabilities.badge.globalOff')}</span>
            ) : null}
          </div>
          {server.description ? (
            <p className="bot-cap-row-desc">{server.description}</p>
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
          <Switch
            checked={server.effectiveEnabled}
            disabled={saving}
            aria-label={server.name}
            onCheckedChange={onToggle}
          />
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

export function BotCapabilitiesTab({
  capabilities,
  i18n,
  onOpenGlobalPlugins,
}: {
  readonly capabilities: BotCapabilitiesState;
  readonly i18n: I18nRuntime;
  readonly onOpenGlobalPlugins?: () => void;
}) {
  useEffect(() => {
    void capabilities.refresh();
  }, [capabilities.refresh]);

  return (
    <div className="bot-drawer-tab bot-capabilities-tab">
      <div className="bot-cap-drawer-intro">
        <p>{i18n.t('projectAgent.capabilities.subtitle')}</p>
        <div className="bot-cap-drawer-intro-actions">
          {capabilities.hasOverrides ? (
            <button
              type="button"
              className="ui-button"
              disabled={capabilities.saving}
              onClick={() => { void capabilities.resetOverrides(); }}
            >
              {i18n.t('projectAgent.capabilities.resetGlobal')}
            </button>
          ) : null}
          {onOpenGlobalPlugins ? (
            <button
              type="button"
              className="ui-button"
              onClick={onOpenGlobalPlugins}
            >
              <span>{i18n.t('projectAgent.capabilities.manageGlobal')}</span>
              <PeerIcon name="arrowUpRight" size={14} />
            </button>
          ) : null}
        </div>
      </div>

      {capabilities.error ? (
        <p className="bot-cap-error" role="alert">
          {i18n.t('projectAgent.capabilities.saveFailed')}
        </p>
      ) : null}

      <SettingsGroup
        className="bot-cap-drawer-group"
        title={`${i18n.t('projectAgent.capabilities.group.skills')} · ${capabilities.mountedSkillCount}/${capabilities.skills.length}`}
      >
        {capabilities.loading && capabilities.skills.length === 0 ? (
          <p className="bot-cap-empty">{i18n.t('projectAgent.capabilities.loading')}</p>
        ) : capabilities.skills.length === 0 ? (
          <p className="bot-cap-empty">{i18n.t('projectAgent.capabilities.empty.skills')}</p>
        ) : (
          <div className="bot-cap-drawer-list">
            {capabilities.skills.map((skill) => (
              <div
                key={skill.skillId}
                className={`bot-cap-drawer-item${!skill.effectiveEnabled ? ' is-muted' : ''}`}
              >
                <div className="bot-cap-row">
                  <div className="bot-cap-row-main">
                    <div className="bot-cap-row-title-line">
                      <span className="bot-cap-row-name" title={skill.name}>{skill.name}</span>
                      {skill.scope === 'workspace' ? (
                        <span className="bot-cap-tag">
                          {i18n.t('projectAgent.capabilities.badge.workspace')}
                        </span>
                      ) : null}
                      {skill.overridden ? (
                        <span className={`bot-cap-tag${skill.effectiveEnabled ? ' is-accent' : ''}`}>
                          {i18n.t(
                            skill.effectiveEnabled
                              ? 'projectAgent.capabilities.badge.overrideOn'
                              : 'projectAgent.capabilities.badge.overrideOff',
                          )}
                        </span>
                      ) : !skill.defaultEnabled ? (
                        <span className="bot-cap-tag">
                          {i18n.t('projectAgent.capabilities.badge.globalOff')}
                        </span>
                      ) : null}
                    </div>
                    {skill.description ? (
                      <p className="bot-cap-row-desc">{skill.description}</p>
                    ) : null}
                  </div>
                  <div className="bot-cap-row-actions">
                    <Switch
                      checked={skill.effectiveEnabled}
                      disabled={capabilities.saving}
                      aria-label={skill.name}
                      onCheckedChange={(next) => { void capabilities.toggleSkill(skill.skillId, next); }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        className="bot-cap-drawer-group"
        title={`${i18n.t('projectAgent.capabilities.group.mcp')} · ${capabilities.mountedMcpCount}/${capabilities.mcps.length}`}
      >
        {capabilities.loading && capabilities.mcps.length === 0 ? (
          <p className="bot-cap-empty">{i18n.t('projectAgent.capabilities.loading')}</p>
        ) : capabilities.mcps.length === 0 ? (
          <p className="bot-cap-empty">{i18n.t('projectAgent.capabilities.empty.mcp')}</p>
        ) : (
          <div className="bot-cap-drawer-list">
            {capabilities.mcps.map((server) => (
              <DrawerMcpRow
                key={server.id}
                server={server}
                saving={capabilities.saving}
                i18n={i18n}
                onToggle={(next) => { void capabilities.toggleMcp(server.id, next); }}
              />
            ))}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        className="bot-cap-drawer-group"
        title={i18n.t('projectAgent.capabilities.group.builtin')}
        description={i18n.t('projectAgent.capabilities.builtinHint')}
      >
        <div className="bot-cap-drawer-builtins">
          {capabilities.builtins.map((item) => (
            <span key={item.key} className="bot-cap-builtin-pill">
              {i18n.t(`projectAgent.capabilities.builtin.${item.key}`)}
            </span>
          ))}
        </div>
      </SettingsGroup>
    </div>
  );
}
