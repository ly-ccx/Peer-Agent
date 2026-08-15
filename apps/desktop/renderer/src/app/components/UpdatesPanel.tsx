import type { I18nRuntime } from '@peer-agent/i18n';
import type { UpdateChannelPreference } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { useUpdater } from '../state/useUpdater';
import { Dropdown } from './Dropdown';

function ExternalLinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
    </svg>
  );
}

/**
 * UpdatesPanel —— 设置中的独立「更新与关于」分区（表达层）。
 *
 * 提供：
 *   - 当前版本号展示
 *   - 更新通道选择（auto / beta / stable），写回 settings 并触发主进程切换
 *   - 「检查更新」入口
 *   - 源仓库 / 反馈 / 发布说明外链（kind 交给主进程白名单打开）
 *
 * 能力真相在主进程，通过 useUpdater 共享同一份状态（与侧边栏徽标一致）。
 */
export function UpdatesPanel({ i18n }: { readonly i18n: I18nRuntime }) {
  const { status, check, download, install, openInstaller, setChannel } = useUpdater();

  const channelOptions = [
    { value: 'auto', label: i18n.t('updater.settings.channel.auto') },
    { value: 'beta', label: i18n.t('updater.settings.channel.beta') },
    { value: 'stable', label: i18n.t('updater.settings.channel.stable') },
  ];

  const preference: UpdateChannelPreference = status?.preference ?? 'auto';
  const checking = status?.phase === 'checking';
  const phase = status?.phase;
  const isAvailable = phase === 'available';
  const isDownloading = phase === 'downloading';
  const isReady = phase === 'downloaded' || phase === 'ready-to-open';
  const percent = Math.max(0, Math.min(100, Math.round(status?.percent ?? 0)));

  const handleInstall = () => {
    if (phase === 'ready-to-open') {
      void openInstaller();
    } else {
      void install();
    }
  };

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
            {isReady ? (
              <button
                type="button"
                className="updater-btn primary"
                onClick={handleInstall}
              >
                {phase === 'ready-to-open'
                  ? i18n.t('updater.badge.openInstaller')
                  : i18n.t('updater.badge.install')}
              </button>
            ) : isDownloading ? (
              <span className="updater-inline-progress">
                {i18n.t('updater.badge.downloading', { percent })}
              </span>
            ) : (
              <button
                type="button"
                className="updater-btn"
                disabled={checking || !status?.enabled}
                onClick={() => {
                  if (isAvailable) {
                    void download();
                  } else {
                    void check();
                  }
                }}
              >
                {checking
                  ? i18n.t('updater.settings.checking')
                  : isAvailable
                    ? i18n.t('updater.modal.update')
                    : i18n.t('updater.settings.checkNow')}
              </button>
            )}
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

      <section className="llm-instructions-card general-card">
        <div className="general-setting-copy">
          <h3>{i18n.t('updater.settings.help.title')}</h3>
          <p>{i18n.t('updater.settings.help.description')}</p>
        </div>
        <div className="settings-help-links">
          <button
            type="button"
            className="settings-help-link"
            onClick={() => { void clientApi.openProductLink('github'); }}
          >
            <ExternalLinkIcon />
            {i18n.t('updater.settings.help.github')}
          </button>
          <button
            type="button"
            className="settings-help-link"
            onClick={() => { void clientApi.openProductLink('feedback'); }}
          >
            <ExternalLinkIcon />
            {i18n.t('updater.settings.help.feedback')}
          </button>
          <button
            type="button"
            className="settings-help-link"
            onClick={() => { void clientApi.openProductLink('releaseNotes'); }}
          >
            <ExternalLinkIcon />
            {i18n.t('updater.settings.help.releaseNotes')}
          </button>
        </div>
      </section>
    </div>
  );
}
