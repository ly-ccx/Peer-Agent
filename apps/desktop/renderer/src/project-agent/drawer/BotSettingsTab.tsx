import { MotionDetails } from '../../app/components/MotionDetails';
import { useEditableResource } from '../../ui/forms/useEditableResource';
import { FormFeedback } from '../../ui/forms/FormFeedback';
import { useSettingsAction } from '../../ui/forms/useSettingsAction';
import { readBotDetails } from '../state/botDetails';
import { BotModelFeedback } from '../BotModelFeedback';
import type { I18nRuntime, TranslationKey } from '@peer-agent/i18n';
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_HEADS,
  BOT_AVATAR_NECKS,
  type BotAvatar,
  type BotAvatarHead,
  type BotAvatarNeck,
  type BotAvatarPartsPatch,
  type BotProfile,
  type BotProfileCommunicationStyle,
} from '@peer-agent/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { Dropdown } from '../../app/components/Dropdown';
import { Switch } from '../../ui/boolean-controls/Switch';
import { SettingsGroup } from '../../ui/settings/SettingsGroup';
import { BotHostControl } from './BotHostControl';
import type { BotModelsControlState } from '../state/useBotModels';
import { BotApprovalFields, BotPolicyFields } from './BotPolicyFields';
import { PeerIcon } from '../../ui/icons/PeerIcon';
import { BotAvatar as BotAvatarView, botAvatarDisplayColor } from '../BotAvatar';
import {
  CAT_COATS,
  createRandomCatParts,
  resolveCatAvatarConfig,
  type BotAvatarShape,
} from '../botCatParts';

const PROACTIVITY_LEVELS = ['inherit', 'quiet', 'low', 'standard', 'high', 'muted'] as const;
type ProactivityLevel = typeof PROACTIVITY_LEVELS[number];
const COMMUNICATION_STYLES: readonly BotProfileCommunicationStyle[] = ['inherit', 'natural', 'concise', 'detailed', 'technical'] as const;
const COLOR_NAME_KEYS: readonly TranslationKey[] = [
  'projectAgent.drawer.settings.avatarColor.0',
  'projectAgent.drawer.settings.avatarColor.1',
  'projectAgent.drawer.settings.avatarColor.2',
  'projectAgent.drawer.settings.avatarColor.3',
  'projectAgent.drawer.settings.avatarColor.4',
  'projectAgent.drawer.settings.avatarColor.5',
  'projectAgent.drawer.settings.avatarColor.6',
  'projectAgent.drawer.settings.avatarColor.7',
];

type StudioTab = 'coat' | 'head' | 'neck';

const STUDIO_TABS: readonly { readonly id: StudioTab; readonly labelKey: TranslationKey }[] = [
  { id: 'coat', labelKey: 'projectAgent.drawer.settings.avatarTab.coat' },
  { id: 'head', labelKey: 'projectAgent.drawer.settings.avatarTab.head' },
  { id: 'neck', labelKey: 'projectAgent.drawer.settings.avatarTab.neck' },
];

const COAT_LABEL_KEYS: Readonly<Record<BotAvatarShape, TranslationKey>> = {
  circle: 'projectAgent.drawer.settings.avatarCoat.circle',
  square: 'projectAgent.drawer.settings.avatarCoat.square',
  pill: 'projectAgent.drawer.settings.avatarCoat.pill',
  arch: 'projectAgent.drawer.settings.avatarCoat.arch',
  hex: 'projectAgent.drawer.settings.avatarCoat.hex',
  diamond: 'projectAgent.drawer.settings.avatarCoat.diamond',
  triangle: 'projectAgent.drawer.settings.avatarCoat.triangle',
  star: 'projectAgent.drawer.settings.avatarCoat.star',
};

const HEAD_LABEL_KEYS: Readonly<Record<BotAvatarHead, TranslationKey>> = {
  none: 'projectAgent.drawer.settings.avatarHead.none',
  beret: 'projectAgent.drawer.settings.avatarHead.beret',
  glasses: 'projectAgent.drawer.settings.avatarHead.glasses',
  beanie: 'projectAgent.drawer.settings.avatarHead.beanie',
  vermeer: 'projectAgent.drawer.settings.avatarHead.vermeer',
  straw: 'projectAgent.drawer.settings.avatarHead.straw',
  headphones: 'projectAgent.drawer.settings.avatarHead.headphones',
  crown: 'projectAgent.drawer.settings.avatarHead.crown',
};

const NECK_LABEL_KEYS: Readonly<Record<BotAvatarNeck, TranslationKey>> = {
  bowtie: 'projectAgent.drawer.settings.avatarNeck.bowtie',
  scarf: 'projectAgent.drawer.settings.avatarNeck.scarf',
  sweater: 'projectAgent.drawer.settings.avatarNeck.sweater',
  moon: 'projectAgent.drawer.settings.avatarNeck.moon',
  sailor: 'projectAgent.drawer.settings.avatarNeck.sailor',
  cape: 'projectAgent.drawer.settings.avatarNeck.cape',
};

function isProactivityLevel(value: string): value is ProactivityLevel {
  return (PROACTIVITY_LEVELS as readonly string[]).includes(value);
}

function isCommunicationStyle(value: string): value is BotProfileCommunicationStyle {
  return (COMMUNICATION_STYLES as readonly string[]).includes(value);
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
  const [studioTab, setStudioTab] = useState<StudioTab>('coat');
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
  const name = nameForm.draft, level = profile.proactivity || 'inherit', communicationStyle: BotProfileCommunicationStyle = profile.communicationStyle || 'inherit';
  const busy = action.busy || nameForm.saving || concurrencyForm.saving;
  const [confirmDelete, setConfirmDelete] = useState(false);

  const resolvedCat = resolveCatAvatarConfig(profile.avatar, workspaceId);
  const activeColorIndex = Math.max(0, BOT_AVATAR_COLORS.indexOf(resolvedCat.color));
  const previewBaseAvatar: Extract<BotAvatar, { kind: 'generated' }> = {
    kind: 'generated',
    shape: resolvedCat.shape,
    color: resolvedCat.color,
    variant: resolvedCat.variant,
    head: resolvedCat.head,
    neck: resolvedCat.neck,
    backdrop: resolvedCat.backdrop,
  };

  const saveConcurrency = async (value: string) => { concurrencyForm.edit(value); await concurrencyForm.save(); };
  const saveName = nameForm.save;
  const saveProactivity = async (next: string) => {
    if (!isProactivityLevel(next)) return;
    await savePolicy({ proactivity: next });
  };
  const saveCommunicationStyle = async (next: string) => {
    if (!isCommunicationStyle(next)) return;
    await savePolicy({ communicationStyle: next });
  };
  async function savePolicy(patch: Pick<BotProfile, 'planApproval' | 'acceptancePolicy' | 'modelPolicy' | 'autoHandoffOnPolicyAccept' | 'proactivity' | 'communicationStyle'>) {
    if (busy) return;
    await action.run(async () => {
      const result = await clientApi.projectAgentUpdateProfile({ workspaceId, ...patch });
      if (!result.ok || !result.profile) throw Error(result.code || 'FAILED');
      onProfile(result.profile);
    });
  }
  /** ADR 127: closure delegation uses its own audited seam, never the generic profile patch. */
  const saveUnknownOutcomePolicy = async (next: string) => {
    if (busy || (next !== 'ask' && next !== 'bot_verified')) return;
    await action.run(async () => {
      const result = await clientApi.projectAgentSetUnknownOutcomePolicy({ workspaceId, tier: next });
      if (!result.ok) throw Error(result.code || 'FAILED');
      onProfile({ ...profile, unknownOutcomePolicy: result.policy ?? null });
    });
  };
  async function updateAvatarParts(avatarParts: BotAvatarPartsPatch) {
    if (busy) return;
    await action.run(async () => {
      const result = await clientApi.projectAgentUpdateProfile({ workspaceId, avatarParts });
      if (!result.ok || !result.profile) throw Error(result.code || 'FAILED');
      onProfile(result.profile);
    });
  }
  async function shuffleAvatar() {
    await updateAvatarParts(createRandomCatParts(resolvedCat));
  }
  async function changeAvatarColor(color: string) {
    if (busy || (profile.avatar.kind === 'generated' && botAvatarDisplayColor(profile.avatar.color) === color)) return;
    await updateAvatarParts({ color });
  }
  async function toggleBackdrop() {
    await updateAvatarParts({ backdrop: !resolvedCat.backdrop });
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
        <div className="bot-settings-avatar-section bot-cat-studio">
          <div className="bot-avatar-settings bot-cat-studio-hero">
            <BotAvatarView avatar={profile.avatar} label={profile.displayName} workspaceId={workspaceId} />
            <div className="bot-cat-studio-meta">
              <strong className="bot-cat-studio-title">
                {`${i18n.t(COAT_LABEL_KEYS[resolvedCat.shape])} · ${i18n.t(COLOR_NAME_KEYS[activeColorIndex]!)}`}
              </strong>
              <div className="bot-cat-studio-tags">
                <span>{i18n.t(HEAD_LABEL_KEYS[resolvedCat.head])}</span>
                <span>{i18n.t(NECK_LABEL_KEYS[resolvedCat.neck])}</span>
              </div>
              <div className="bot-avatar-settings-actions">
                <button type="button" className="ui-button bot-cat-studio-action" disabled={busy} onClick={() => { void shuffleAvatar(); }}>
                  {i18n.t('projectAgent.drawer.settings.avatarNew')}
                </button>
                <button
                  type="button"
                  className="ui-button bot-cat-studio-action bot-cat-studio-backdrop-toggle"
                  aria-pressed={resolvedCat.backdrop}
                  disabled={busy}
                  onClick={() => { void toggleBackdrop(); }}
                >
                  {i18n.t('projectAgent.drawer.settings.avatarBackdrop')}
                </button>
              </div>
            </div>
          </div>

          <div className="bot-avatar-colors" role="group" aria-label={i18n.t('projectAgent.drawer.settings.avatarColor')}>
            <div className="bot-avatar-colors-head">
              <span>{i18n.t('projectAgent.drawer.settings.avatarColor')}</span>
              <small>{i18n.t('projectAgent.drawer.settings.avatarColorSyncHint')}</small>
            </div>
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

          <div className="bot-cat-builder">
            <div className="bot-cat-tabs" role="tablist" aria-label={i18n.t('projectAgent.drawer.settings.avatar')}>
              {STUDIO_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  className={`bot-cat-tab${studioTab === tab.id ? ' is-active' : ''}`}
                  aria-selected={studioTab === tab.id}
                  onClick={() => setStudioTab(tab.id)}
                >
                  {i18n.t(tab.labelKey)}
                </button>
              ))}
            </div>

            <div className="bot-cat-part-grid" role="tabpanel">
              {studioTab === 'coat'
                ? CAT_COATS.map((coat) => {
                  const selected = profile.avatar.kind === 'generated' && resolvedCat.shape === coat.shape;
                  const label = i18n.t(COAT_LABEL_KEYS[coat.shape]);
                  return (
                    <button
                      key={coat.shape}
                      type="button"
                      className={`bot-cat-part-tile${selected ? ' is-active' : ''}`}
                      aria-pressed={selected}
                      disabled={busy}
                      onClick={() => { void updateAvatarParts({ shape: coat.shape }); }}
                    >
                      <BotAvatarView
                        avatar={{ ...previewBaseAvatar, shape: coat.shape }}
                        label={label}
                        workspaceId={workspaceId}
                        interactive={false}
                      />
                      <span>{label}</span>
                    </button>
                  );
                })
                : null}

              {studioTab === 'head'
                ? BOT_AVATAR_HEADS.map((head) => {
                  const selected = profile.avatar.kind === 'generated' && resolvedCat.head === head;
                  const label = i18n.t(HEAD_LABEL_KEYS[head]);
                  return (
                    <button
                      key={head}
                      type="button"
                      className={`bot-cat-part-tile${selected ? ' is-active' : ''}`}
                      aria-pressed={selected}
                      disabled={busy}
                      onClick={() => { void updateAvatarParts({ head }); }}
                    >
                      <BotAvatarView
                        avatar={{ ...previewBaseAvatar, head }}
                        label={label}
                        workspaceId={workspaceId}
                        interactive={false}
                      />
                      <span>{label}</span>
                    </button>
                  );
                })
                : null}

              {studioTab === 'neck'
                ? BOT_AVATAR_NECKS.map((neck) => {
                  const selected = profile.avatar.kind === 'generated' && resolvedCat.neck === neck;
                  const label = i18n.t(NECK_LABEL_KEYS[neck]);
                  return (
                    <button
                      key={neck}
                      type="button"
                      className={`bot-cat-part-tile${selected ? ' is-active' : ''}`}
                      aria-pressed={selected}
                      disabled={busy}
                      onClick={() => { void updateAvatarParts({ neck }); }}
                    >
                      <BotAvatarView
                        avatar={{ ...previewBaseAvatar, neck }}
                        label={label}
                        workspaceId={workspaceId}
                        interactive={false}
                      />
                      <span>{label}</span>
                    </button>
                  );
                })
                : null}
            </div>
          </div>
        </div>
      </SettingsGroup>
      <SettingsGroup className="bot-settings-section bot-settings-workflow" title={i18n.t('projectAgent.drawer.settings.workflow')}>
        <div className="bot-settings-row">
          <span>{i18n.t('projectAgent.drawer.settings.communicationStyle')}</span>
          <Dropdown
            value={communicationStyle}
            disabled={busy}
            ariaLabel={i18n.t('projectAgent.drawer.settings.communicationStyle')}
            options={COMMUNICATION_STYLES.map((item) => ({ value: item, label: i18n.t(`projectAgent.drawer.settings.communicationStyle.${item}`) }))}
            onChange={(next) => { void saveCommunicationStyle(next); }}
          />
        </div>
        <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.settings.communicationStyleHint')}</p>
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
        <div className="bot-settings-row">
          <span>{i18n.t('projectAgent.drawer.settings.unknownOutcomePolicy')}</span>
          <Dropdown
            value={profile.unknownOutcomePolicy?.tier || 'ask'}
            disabled={busy}
            ariaLabel={i18n.t('projectAgent.drawer.settings.unknownOutcomePolicy')}
            options={[
              { value: 'ask', label: i18n.t('projectAgent.drawer.settings.unknownOutcomePolicy.ask') },
              { value: 'bot_verified', label: i18n.t('projectAgent.drawer.settings.unknownOutcomePolicy.botVerified') },
            ]}
            onChange={(next) => { void saveUnknownOutcomePolicy(next); }}
          />
        </div>
        <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.settings.unknownOutcomePolicyHint')}</p>
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
