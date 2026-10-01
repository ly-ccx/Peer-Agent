import type { I18nRuntime } from '@peer-agent/i18n';
import { BOT_AVATAR_COLORS, type BotProfile, type ModelRoutingMenuOption } from '@peer-agent/protocol';
import { useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import { Dropdown } from '../../app/components/Dropdown';
import { BotPolicyFields } from './BotPolicyFields';
import { BotAvatar, botAvatarDisplayColor } from '../BotAvatar';

const PROACTIVITY_LEVELS = ['inherit', 'quiet', 'low', 'standard', 'high', 'muted'] as const;
type ProactivityLevel = typeof PROACTIVITY_LEVELS[number];
const COLOR_NAME_KEYS = [
  'projectAgent.drawer.settings.avatarColor.0',
  'projectAgent.drawer.settings.avatarColor.1',
  'projectAgent.drawer.settings.avatarColor.2',
  'projectAgent.drawer.settings.avatarColor.3',
  'projectAgent.drawer.settings.avatarColor.4',
  'projectAgent.drawer.settings.avatarColor.5',
  'projectAgent.drawer.settings.avatarColor.6',
  'projectAgent.drawer.settings.avatarColor.7',
] as const;

function isProactivityLevel(value: string): value is ProactivityLevel {
  return (PROACTIVITY_LEVELS as readonly string[]).includes(value);
}

/**
 * 名字、头像和删除只走项目代理 IPC。
 * 策略与模型覆盖同样由宿主校验并保存。
 */
export function BotSettingsTab({
  workspaceId,
  profile,
  modelOptions = [],
  i18n,
  onProfile,
  onDeleted,
}: {
  readonly workspaceId: string;
  readonly profile: BotProfile;
  readonly modelLabel: string;
  readonly modelOptions?: readonly ModelRoutingMenuOption[];
  readonly i18n: I18nRuntime;
  readonly onProfile: (profile: BotProfile) => void;
  readonly onDeleted: () => void;
}) {
  const [name, setName] = useState(profile.displayName);
  const [level, setLevel] = useState<ProactivityLevel>(profile.proactivity || 'inherit');
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [concurrency, setConcurrency] = useState('4');
  useEffect(() => {
    let live = true;
    void clientApi.getSettings().then(settings => {
      if (!live) return;
      const project = settings.projectAgent as { concurrency?: number } | undefined;
      setConcurrency(String(project?.concurrency || 4));
    }).catch(() => { if (live) setError('FAILED'); });
    return () => { live = false; };
  }, []);
  async function saveConcurrency(value: string) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const saved = await clientApi.updateSettings({ projectAgent: { concurrency: Number(value) } });
      const project = saved.projectAgent as { concurrency?: number } | undefined;
      setConcurrency(String(project?.concurrency || 4));
    } catch { setError('FAILED'); }
    finally { setBusy(false); }
  }


  async function saveName() {
    const displayName = name.trim();
    if (!displayName || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await clientApi.projectAgentUpdateProfile({ workspaceId, displayName });
      if (!result?.ok || !result.profile) {
        setError(result?.code || 'FAILED');
        return;
      }
      onProfile(result.profile);
    } finally {
      setBusy(false);
    }
  }

  async function saveProactivity(next: string) {
    if (!isProactivityLevel(next)) return;
    const previous = level;
    setLevel(next);
    setBusy(true);
    setError('');
    try {
      const result = await clientApi.projectAgentUpdateProfile({ workspaceId, proactivity: next });
      if (!result?.ok || !result.profile) {
        setLevel(previous);
        setError(result?.code || 'FAILED');
        return;
      }
      onProfile(result.profile);
    } finally {
      setBusy(false);
    }
  }

  async function savePolicy(patch: Pick<BotProfile, 'planApproval' | 'acceptancePolicy' | 'modelPolicy'>) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await clientApi.projectAgentUpdateProfile({ workspaceId, ...patch });
      if (!result?.ok || !result.profile) { setError(result?.code || 'FAILED'); return; }
      onProfile(result.profile);
    } catch { setError('FAILED'); }
    finally { setBusy(false); }
  }

  async function changeAvatar(kind: 'regenerate' | 'upload') {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await clientApi.projectAgentUpdateProfile(
        kind === 'regenerate'
          ? { workspaceId, regenerateAvatar: true }
          : { workspaceId, chooseAvatar: true },
      );
      if (!result?.ok || !result.profile) {
        if (result?.code !== 'CANCELLED') setError(result?.code || 'FAILED');
        return;
      }
      onProfile(result.profile);
    } finally {
      setBusy(false);
    }
  }

  async function changeAvatarColor(color: string) {
    if (busy || profile.avatar.kind === 'generated' && botAvatarDisplayColor(profile.avatar.color) === color) return;
    setBusy(true);
    setError('');
    try {
      const result = await clientApi.projectAgentUpdateProfile({ workspaceId, avatarColor: color });
      if (!result?.ok || !result.profile) {
        setError(result?.code || 'FAILED');
        return;
      }
      onProfile(result.profile);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (profile.managed === true && !confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await clientApi.projectAgentDelete({
        workspaceId,
        confirmManaged: profile.managed === true,
      });
      if (!result?.ok) {
        setError(result?.code || 'FAILED');
        return;
      }
      onDeleted();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bot-drawer-tab">
      <div className="bot-settings-field">
        <label htmlFor="bot-settings-name">{i18n.t('projectAgent.drawer.settings.name')}</label>
        <div className="bot-settings-name-row">
          <input id="bot-settings-name" value={name} onChange={(event) => setName(event.target.value)} />
          <button type="button" disabled={busy || !name.trim() || name.trim() === profile.displayName} onClick={() => { void saveName(); }}>
            {i18n.t('projectAgent.drawer.settings.save')}
          </button>
        </div>
      </div>
      <section className="bot-settings-avatar-section">
        <h2>{i18n.t('projectAgent.drawer.settings.avatar')}</h2>
        <div className="bot-avatar-settings">
          <BotAvatar avatar={profile.avatar} label={profile.displayName} workspaceId={workspaceId} />
          <div className="bot-avatar-settings-actions">
            <button type="button" disabled={busy} onClick={() => { void changeAvatar('upload'); }}>
              {i18n.t('projectAgent.drawer.settings.avatarUpload')}
            </button>
            <button type="button" disabled={busy} onClick={() => { void changeAvatar('regenerate'); }}>
              {i18n.t('projectAgent.drawer.settings.avatarNew')}
            </button>
          </div>
        </div>
        <div className="bot-avatar-colors" role="group" aria-label={i18n.t('projectAgent.drawer.settings.avatarColor')}>
          <span>{i18n.t('projectAgent.drawer.settings.avatarColor')}</span>
          <div className="bot-avatar-color-grid">
            {BOT_AVATAR_COLORS.map((color, index) => (
              <button
                key={color}
                type="button"
                className="bot-avatar-color"
                style={{ ['--bot-swatch-color' as string]: color }}
                aria-label={i18n.t(COLOR_NAME_KEYS[index]!)}
                aria-pressed={profile.avatar.kind === 'generated' && botAvatarDisplayColor(profile.avatar.color) === color}
                disabled={busy}
                onClick={() => { void changeAvatarColor(color); }}
              ><span aria-hidden="true" /></button>
            ))}
          </div>
          {profile.avatar.kind === 'image' ? <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.settings.avatarColorImageHint')}</p> : null}
        </div>
      </section>
      <div className="bot-settings-field">
        <span>{i18n.t('projectAgent.drawer.settings.proactivity')}</span>
        <Dropdown
          value={level}
          disabled={busy}
          ariaLabel={i18n.t('projectAgent.drawer.settings.proactivity')}
          className="bot-settings-proactivity"
          options={PROACTIVITY_LEVELS.map((item) => ({ value: item, label: i18n.t(`projectAgent.drawer.settings.proactivity.${item}`) }))}
          onChange={(next) => { void saveProactivity(next); }}
        />
      </div>
      <div className="bot-settings-field">
        <span>{i18n.t('projectAgent.drawer.settings.concurrency')}</span>
        <Dropdown value={concurrency} disabled={busy}
          ariaLabel={i18n.t('projectAgent.drawer.settings.concurrency')}
          options={Array.from({ length: 8 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))}
          onChange={value => { void saveConcurrency(value); }} />
        <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.settings.concurrencyHint')}</p>
      </div>
      <BotPolicyFields profile={profile} models={modelOptions} busy={busy} i18n={i18n}
        onChange={patch => { void savePolicy(patch); }} />
      {error ? <p className="bot-drawer-note">{error}</p> : null}
      <button type="button" disabled={busy} onClick={() => { void remove(); }}>
        {confirmDelete
          ? i18n.t('projectAgent.drawer.settings.deleteConfirm')
          : profile.managed
            ? i18n.t('projectAgent.drawer.settings.deleteManaged')
            : i18n.t('projectAgent.drawer.settings.delete')}
      </button>
    </div>
  );
}
