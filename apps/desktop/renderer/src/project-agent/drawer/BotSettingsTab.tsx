import { MotionDetails } from '../../app/components/MotionDetails';
import { useEditableResource } from '../../ui/forms/useEditableResource';
import { FormFeedback } from '../../ui/forms/FormFeedback';
import { useSettingsAction } from '../../ui/forms/useSettingsAction';
import { readBotDetails } from '../state/botDetails';
import { BotModelFeedback } from '../BotModelFeedback';
import type { I18nRuntime } from '@peer-agent/i18n';
import { BOT_AVATAR_COLORS, type BotProfile } from '@peer-agent/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { Dropdown } from '../../app/components/Dropdown';
import { Switch } from '../../ui/boolean-controls/Switch';
import { SettingsGroup } from '../../ui/settings/SettingsGroup';
import { BotHostControl } from './BotHostControl';
import type { BotModelsControlState } from '../state/useBotModels';
import { BotApprovalFields, BotPolicyFields } from './BotPolicyFields';
import { PeerIcon } from '../../ui/icons/PeerIcon';
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
  modelControls,
  i18n,
  onProfile,
  onDeleted,
}: {
  readonly workspaceId: string;
  readonly profile: BotProfile;
  readonly modelControls: BotModelsControlState;
  readonly i18n: I18nRuntime;
  readonly onProfile: (profile: BotProfile) => void;
  readonly onDeleted: () => void;
}) {
  const nameId = useId();
  const action = useSettingsAction();
  const nameForm = useEditableResource(`bot.${workspaceId}.name`, profile.displayName, {
    read: async () => { const got = await readBotDetails(workspaceId); if (!got.ok || !got.profile) throw Error('read'); return got.profile.displayName; },
    write: async draft => { const displayName = draft.trim(); if (!displayName) throw Error('name'); const got = await clientApi.projectAgentUpdateProfile({ workspaceId, displayName }); if (!got.ok || !got.profile) throw Error('save'); onProfile(got.profile); return got.profile.displayName; },
  });
  const concurrencyForm = useEditableResource('settings.bot-concurrency', '4', {
    read: async () => { const settings = await clientApi.getSettings(); return String((settings.projectAgent as { concurrency?: number } | undefined)?.concurrency || 4); },
    write: async draft => { const saved = await clientApi.updateSettings({ projectAgent: { concurrency: Number(draft) } }); return String((saved.projectAgent as { concurrency?: number } | undefined)?.concurrency || 4); },
  });
  const previousName = useRef(profile.displayName);
  useEffect(() => {
    if (previousName.current !== profile.displayName && !nameForm.saving) void nameForm.reload();
    previousName.current = profile.displayName;
  }, [profile.displayName, nameForm.reload]);
  const name = nameForm.draft, level = profile.proactivity || 'inherit';
  const busy = action.busy || nameForm.saving || concurrencyForm.saving;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saveConcurrency = async (value: string) => { concurrencyForm.edit(value); await concurrencyForm.save(); };
  const saveName = nameForm.save;
  const saveProactivity = async (next: string) => {
    if (!isProactivityLevel(next)) return;
    await savePolicy({ proactivity: next });
  };
  async function savePolicy(patch: Pick<BotProfile, 'planApproval' | 'acceptancePolicy' | 'modelPolicy' | 'autoHandoffOnPolicyAccept' | 'proactivity'>) {
    if (busy) return;
    await action.run(async () => {
      const result = await clientApi.projectAgentUpdateProfile({ workspaceId, ...patch });
      if (!result.ok || !result.profile) throw Error(result.code || 'FAILED');
      onProfile(result.profile);
    });
  }
  async function regenerateAvatar() {
    if (busy) return;
    await action.run(async () => {
      const result = await clientApi.projectAgentUpdateProfile({ workspaceId, regenerateAvatar: true });
      if (!result.ok || !result.profile) throw Error(result.code || 'FAILED');
      onProfile(result.profile);
    });
  }
  async function changeAvatarColor(color: string) {
    if (busy || profile.avatar.kind === 'generated' && botAvatarDisplayColor(profile.avatar.color) === color) return;
    await action.run(async () => {
      const result = await clientApi.projectAgentUpdateProfile({ workspaceId, avatarColor: color });
      if (!result.ok || !result.profile) throw Error(result.code || 'FAILED');
      onProfile(result.profile);
    });
  }
  async function remove() {
    if (busy) return;
    if (profile.managed === true && !confirmDelete) { setConfirmDelete(true); return; }
    await action.run(async () => {
      const result = await clientApi.projectAgentDelete({ workspaceId, confirmManaged: profile.managed === true });
      if (!result.ok) throw Error(result.code || 'FAILED');
      onDeleted();
    });
  }

  return (
    <div className="bot-drawer-tab bot-settings-tab">
      <BotPolicyFields profile={profile} models={modelControls.models} views={modelControls.views} busy={busy || modelControls.busy} i18n={i18n}
        modelFeedback={modelControls}
        feedback={<BotModelFeedback state={modelControls} i18n={i18n} showSaving={false} />}
        onChange={patch => patch.modelPolicy ? modelControls.save(patch.modelPolicy) : undefined} />
      <SettingsGroup className="bot-settings-section bot-settings-identity" title={i18n.t('projectAgent.drawer.settings.appearance')}>
      <div className="bot-settings-field">
        <label htmlFor={nameId}>{i18n.t('projectAgent.drawer.settings.name')}</label>
        <div className="bot-settings-name-row">
          <input id={nameId} className="ui-input" value={name} disabled={!nameForm.loaded || nameForm.saving} aria-describedby={`${nameId}-status`} aria-invalid={nameForm.saveError || undefined} onChange={(event) => nameForm.edit(event.target.value)} />
          <button type="button" className="ui-button is-primary" disabled={busy || !nameForm.loaded || !name.trim() || !nameForm.dirty} onClick={() => { void saveName(); }}>
            {i18n.t('projectAgent.drawer.settings.save')}
          </button>
        </div>
      </div>
      <FormFeedback id={`${nameId}-status`} i18n={i18n} {...nameForm} onReload={nameForm.reload} onRetry={nameForm.save} />
      {nameForm.dirty ? <p className="bot-drawer-note">{i18n.t('forms.retainedDraft')}</p> : null}
      <div className="bot-settings-avatar-section">
        <div className="bot-avatar-settings">
          <BotAvatar avatar={profile.avatar} label={profile.displayName} workspaceId={workspaceId} />
          <div className="bot-avatar-settings-actions">
            <button type="button" className="ui-button" disabled={busy} onClick={() => { void regenerateAvatar(); }}>
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
      </div>
      </SettingsGroup>
      <SettingsGroup className="bot-settings-section bot-settings-workflow" title={i18n.t('projectAgent.drawer.settings.workflow')}>
      <div className="bot-settings-row">
        <span>{i18n.t('projectAgent.drawer.settings.proactivity')}</span>
        <Dropdown
          value={level}
          disabled={busy}
          ariaLabel={i18n.t('projectAgent.drawer.settings.proactivity')}
          options={PROACTIVITY_LEVELS.map((item) => ({ value: item, label: i18n.t(`projectAgent.drawer.settings.proactivity.${item}`) }))}
          onChange={(next) => { void saveProactivity(next); }}
        />
      </div>
      <BotApprovalFields profile={profile} busy={busy} i18n={i18n}
        onChange={patch => { void savePolicy(patch); }} />
      <div className="bot-settings-row bot-settings-toggle-row">
        <label htmlFor="bot-auto-handoff">{i18n.t('projectAgent.drawer.settings.autoHandoff')}</label>
        <Switch id="bot-auto-handoff" checked={profile.autoHandoffOnPolicyAccept === true} disabled={busy}
          onCheckedChange={value => { void savePolicy({ autoHandoffOnPolicyAccept: value }); }} />
      </div>
      <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.settings.autoHandoffHint')}</p>
      </SettingsGroup>
      <MotionDetails className="bot-settings-disclosure bot-runtime-settings">
        <summary>{i18n.t('projectAgent.drawer.settings.runtime')}<PeerIcon name="chevronDown" size={14} /></summary>
        <div className="bot-settings-disclosure-body">
          <BotHostControl workspaceId={workspaceId} i18n={i18n} />
          <div className="bot-settings-global">
            <span className="bot-settings-scope">{i18n.t('projectAgent.drawer.settings.globalScope')}</span>
            <div className="bot-settings-row">
              <span>{i18n.t('projectAgent.drawer.settings.concurrency')}</span>
              <Dropdown value={concurrencyForm.draft} disabled={busy || !concurrencyForm.loaded}
                ariaLabel={i18n.t('projectAgent.drawer.settings.concurrency')}
                options={Array.from({ length: 8 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))}
                onChange={value => { void saveConcurrency(value); }} />
            </div>
            <FormFeedback i18n={i18n} {...concurrencyForm} onReload={concurrencyForm.reload} onRetry={concurrencyForm.save} />
            <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.settings.concurrencyHint')}</p>
          </div>
        </div>
      </MotionDetails>
      <FormFeedback i18n={i18n} saving={action.busy} saveError={action.error} committed={action.committed} onRetry={action.retry} />
      <div className="bot-settings-danger">
      <button type="button" className="ui-button" disabled={busy} onClick={() => { void remove(); }}>
        {confirmDelete
          ? i18n.t('projectAgent.drawer.settings.deleteConfirm')
          : profile.managed
            ? i18n.t('projectAgent.drawer.settings.deleteManaged')
            : i18n.t('projectAgent.drawer.settings.delete')}
      </button>
      </div>
    </div>
  );
}
