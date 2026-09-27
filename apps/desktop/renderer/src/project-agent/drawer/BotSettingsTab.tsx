import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotProfile } from '@peer-agent/protocol';
import { useState } from 'react';
import { clientApi } from '../../clientApi';

const PROACTIVITY_LEVELS = ['inherit', 'quiet', 'low', 'standard', 'high', 'muted'] as const;
type ProactivityLevel = typeof PROACTIVITY_LEVELS[number];

function isProactivityLevel(value: string): value is ProactivityLevel {
  return (PROACTIVITY_LEVELS as readonly string[]).includes(value);
}

/**
 * 名字、头像和删除只走项目代理 IPC。
 * 签收策略和项目模型覆盖还没有单独的写入通道，这里只展示，不另存一份。
 */
export function BotSettingsTab({
  workspaceId,
  profile,
  modelLabel,
  i18n,
  onProfile,
  onDeleted,
}: {
  readonly workspaceId: string;
  readonly profile: BotProfile;
  readonly modelLabel: string;
  readonly i18n: I18nRuntime;
  readonly onProfile: (profile: BotProfile) => void;
  readonly onDeleted: () => void;
}) {
  const [name, setName] = useState(profile.displayName);
  const [level, setLevel] = useState<ProactivityLevel>(profile.proactivity || 'inherit');
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

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
      <label>
        <span>{i18n.t('projectAgent.drawer.settings.name')}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <button type="button" disabled={busy || !name.trim()} onClick={() => { void saveName(); }}>
        {i18n.t('projectAgent.drawer.settings.save')}
      </button>
      <section>
        <h2>{i18n.t('projectAgent.drawer.settings.avatar')}</h2>
        <button type="button" disabled={busy} onClick={() => { void changeAvatar('regenerate'); }}>
          {i18n.t('projectAgent.drawer.settings.avatarNew')}
        </button>
        <button type="button" disabled={busy} onClick={() => { void changeAvatar('upload'); }}>
          {i18n.t('projectAgent.drawer.settings.avatarUpload')}
        </button>
      </section>
      <label>
        <span>{i18n.t('projectAgent.drawer.settings.proactivity')}</span>
        <select
          value={level}
          disabled={busy}
          onChange={(event) => { void saveProactivity(event.target.value); }}
        >
          {PROACTIVITY_LEVELS.map((item) => (
            <option key={item} value={item}>
              {i18n.t(`projectAgent.drawer.settings.proactivity.${item}`)}
            </option>
          ))}
        </select>
      </label>
      <section>
        <h2>{i18n.t('projectAgent.drawer.acceptance')}</h2>
        <p>{i18n.t('projectAgent.drawer.acceptance.auto')}</p>
        <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.acceptance.pending')}</p>
      </section>
      <section>
        <h2>{i18n.t('projectAgent.drawer.model')}</h2>
        <p>{modelLabel || i18n.t('projectAgent.drawer.modelEmpty')}</p>
        <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.model.pending')}</p>
      </section>
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
