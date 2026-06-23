import type { I18nRuntime } from '@peer-agent/i18n';
import type { UpdateChannelPreference } from '@peer-agent/protocol';
import { useUpdater } from '../state/useUpdater';
import { Dropdown } from './Dropdown';

/**
 * UpdatesPanel —— 设置中的独立「更新」分区（表达层）。
 *
 * 提供：
 *   - 当前版本号展示
 *   - 更新通道选择（auto / beta / stable），写回 settings 并触发主进程切换
 *   - 「检查更新」入口
 *
 * 能力真相在主进程，通过 useUpdater 共享同一份状态（与侧边栏徽标一致）。
 */
export function UpdatesPanel({ i18n }: { readonly i18n: I18nRuntime }) {
  const { status, check, setChannel } = useUpdater();

  const channelOptions = [
    { value: 'auto', label: i18n.t('updater.settings.channel.auto') },
    { value: 'beta', label: i18n.t('updater.settings.channel.beta') },
    { value: 'stable', label: i18n.t('updater.settings.channel.stable') },
  ];

  const preference: UpdateChannelPreference = status?.preference ?? 'auto';
  const checking = status?.phase === 'checking';

  return (
    <div className="general-panel">
      <section className="llm-instructions-card general-card">
        <div className="general-setting-row">
          <div className="general-setting-copy">
            <h3>{i18n.t('updater.settings.title')}</h3>
            <p>{i18n.t('updater.settings.description')}</p>
          </div>
        </div>

        <div className="general-setting-row">
          <div className="general-setting-copy">
            <h3>{i18n.t('updater.settings.currentVersion')}</h3>
            <p>v{status?.currentVersion ?? '0.0.0'}</p>
          </div>
          <div className="general-language-select">
            <button
              type="button"
              className="updater-btn"
              disabled={checking || !status?.enabled}
              onClick={() => void check()}
            >
              {checking ? i18n.t('updater.settings.checking') : i18n.t('updater.settings.checkNow')}
            </button>
          </div>
        </div>

        <div className="general-setting-row">
          <div className="general-setting-copy">
            <h3>{i18n.t('updater.settings.channel')}</h3>
            <p>{i18n.t('updater.settings.channel.description')}</p>
          </div>
          <div className="general-language-select">
            <Dropdown
              value={preference}
              options={channelOptions}
              ariaLabel={i18n.t('updater.settings.channel')}
              onChange={(value) => void setChannel(value as UpdateChannelPreference)}
            />
          </div>
        </div>

        {!status?.enabled ? (
          <p className="general-setting-error">{i18n.t('updater.settings.disabledHint')}</p>
        ) : null}
      </section>
    </div>
  );
}
