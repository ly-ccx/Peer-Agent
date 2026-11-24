import { useEditableResource } from '../../../ui/forms/useEditableResource';
import { useUnsavedChanges } from '../../../ui/forms/UnsavedChanges';
import { FormFeedback } from '../../../ui/forms/FormFeedback';
import { readRoutingDraft, editRoutingDraft, routingDraftPatch, type RoutingDraft } from './routingDraft';
import type { I18nRuntime } from '@peer-agent/i18n';
import { isModelReasoningEffort, routingParameters, type ModelTierBinding, type RoleSetting } from '@peer-agent/protocol';
import { effortLabel } from '../../../chat/state/preferences';
import { useEffect, useId, useState } from 'react';
import { clientApi } from '../../../clientApi';
import type {
  ModelRoutingPatch,
  ModelRoutingPreview,
  ModelRoutingPreviewRow,
  ModelRoutingProviderOption,
} from '../../../preload/contracts/bootstrapPreloadApi';
import { Switch } from '../../../ui/boolean-controls';
import { PeerIcon, type PeerIconName } from '../../../ui/icons';
import { SettingsGroup } from '../../../ui/settings/SettingsGroup';
import { ModelPicker } from '../../../ui/model-picker/ModelPicker';
import { selectionGroupsFromMenuGroups } from '../../../ui/model-picker/modelSelection';
import { Dropdown } from '../Dropdown';
import './model-routing.css';
import { RoutingParameterFields } from './RoutingParameterFields';
import {
  MODEL_ROLES,
  MODEL_TIERS,
  isEssentialRole,
  isRoutingReadOnly,
  moveListItem,
  optionRejectReason,
  reasonTranslationKey,
  roleTranslationKey,
  routingMenuGroups,
  routingParameterCandidates,
  setRoutingReasoning,
  tierTranslationKey,
  validateAutoPool,
  withoutId,
  type ModelRoleName,
  type ModelTierName,
  type RoutingModelOption,
} from './modelRoutingPanelState';

function asOptions(providers: readonly ModelRoutingProviderOption[]): RoutingModelOption[] {
  return providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    providerName: provider.providerName,
    groupId: provider.groupId,
    model: provider.model,
    authMethod: provider.authMethod,
    supportsVision: provider.supportsVision,
    supportsTools: provider.supportsTools,
    supportsStructured: provider.supportsStructured,
    contextTokens: provider.contextTokens,
    reasoningEffortLevels: provider.reasoningEffortLevels,
    defaultReasoningEffort: provider.defaultReasoningEffort,
  }));
}

function tierPatch(tier: ModelTierName, primary: string, fallbacks: readonly string[], previous: ModelTierBinding): ModelRoutingPatch {
  const tiers: NonNullable<ModelRoutingPatch['tiers']> = {};
  tiers[tier] = { ...previous, primary, fallbacks };
  return { tiers };
}

function rolePatch(role: ModelRoleName, setting: NonNullable<ModelRoutingPatch['roles']>[ModelRoleName]): ModelRoutingPatch {
  const roles: NonNullable<ModelRoutingPatch['roles']> = {};
  if (setting) roles[role] = setting;
  return { roles };
}


const TIER_META: Record<ModelTierName, { readonly icon: PeerIconName; readonly zh: string; readonly en: string }> = {
  strong: { icon: 'agentSpark', zh: '深度推理、复杂编码与关键决策', en: 'Deep reasoning, complex coding & key decisions' },
  fast: { icon: 'bolt', zh: '低延迟交互与快速响应任务', en: 'Low-latency interaction & rapid tasks' },
  economy: { icon: 'agentLeaf', zh: '轻量后台整理与高性价比调用', en: 'Lightweight background work & cost efficiency' },
  vision: { icon: 'image', zh: '识图、界面审查与视觉核验', en: 'Image understanding & visual verification' },
};

export function ModelRoutingPanel({ i18n }: { readonly i18n: I18nRuntime }) {
  const [preview, setPreview] = useState<ModelRoutingPreview | null>(null);
  const [error, setError] = useState(''), [previewError, setPreviewError] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const preferLabelId = useId();
  const form = useEditableResource<RoutingDraft | null>('settings.model-routing', null, {
    read: async () => readRoutingDraft(await clientApi.modelRoutingGet()),
    write: async (draft, saved) => {
      if (!draft || !saved) throw Error('NOT_LOADED');
      try {
        return readRoutingDraft(await clientApi.modelRoutingUpdate(routingDraftPatch(draft, saved)));
      } catch (failure) {
        const message = String(failure);
        if (message.includes('INVALID_FAST_MODE')) setError(i18n.t('modelRouting.fastUnsupported'));
        else if (message.includes('INVALID_REASONING_EFFORT')) setError(i18n.t('modelRouting.reasoningInvalid'));
        throw failure;
      }
    },
  });
  useUnsavedChanges({ dirty: form.dirty, busy: form.saving, save: form.save, discard: form.reset });
  useEffect(() => {
    let live = true;
    setPreview(null);
    setPreviewError(false);
    void clientApi.modelRoutingPreview().then(result => { if (live) { setPreview(result); setPreviewError(false); } }).catch(() => { if (live) setPreviewError(true); });
    return () => { live = false; };
  }, [form.saved, previewVersion]);
  const view = form.draft ? { ...form.draft.view, providers: form.saved?.view.providers ?? form.draft.view.providers } : null;
  async function save(partial: ModelRoutingPatch) {
    if (!form.draft || form.saving || isRoutingReadOnly(form.draft.view.providers.length)) return;
    setError(''); form.edit(editRoutingDraft(form.draft, partial)); await form.save();
  }
  if (!form.readError && !view) {
    return (
      <div className="settings-panel model-routing-panel">
        <p className="settings-status">{i18n.t('settings.usage.loading')}</p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="settings-panel model-routing-panel">
        <FormFeedback i18n={i18n} {...form} onReload={form.reload} onRetry={form.save} />
      </div>
    );
  }

  const options = asOptions(view.providers);
  const readOnly = form.saving || isRoutingReadOnly(options.length);
  const resolutionFor = (role: string) => preview?.resolutions.find((row) => row.role === role);

  return (
    <div className="settings-panel model-routing-panel">
      <header className="model-routing-header">
        <h2>{i18n.t('modelRouting.title')}</h2>
        <p>{i18n.t('modelRouting.description')}</p>
      </header>
      {options.length === 1 ? <p className="model-routing-banner">{i18n.t('modelRouting.singleModel')}</p> : null}
      {options.length === 0 ? <p className="model-routing-banner">{i18n.t('modelRouting.noModel')}</p> : null}
      <FormFeedback i18n={i18n} {...form} onReload={form.reload} onRetry={form.save} />
      {form.dirty ? <p className="ui-form-feedback">{i18n.t('forms.pendingSelection')}<button type="button" className="ui-button is-compact" disabled={form.saving} onClick={() => { void form.save(); }}>{i18n.t('forms.retry')}</button><button type="button" className="ui-button is-compact" disabled={form.saving} onClick={form.reset}>{i18n.t('forms.discard')}</button></p> : null}
      {previewError ? <p className="ui-form-feedback" role="status">{i18n.t('forms.previewFailed')}<button type="button" className="ui-button" onClick={() => setPreviewVersion(value => value + 1)}>{i18n.t('forms.retry')}</button></p> : null}
      {error ? <p className="settings-warning" role="alert">{error}</p> : null}

      <SettingsGroup className="model-routing-card" title={i18n.t('modelRouting.tiers')}>
        <div className="model-routing-tier-grid">
          {MODEL_TIERS.map((tier) => {
            const binding = view.routing.tiers[tier] || { primary: '', fallbacks: [] };
            const fallbacks = binding.fallbacks || [];
            const tierLabel = i18n.t(tierTranslationKey(tier));
            const meta = TIER_META[tier];
            const isZh = i18n.locale.startsWith('zh');
            const missingPrimary = Boolean(binding.primary) && !options.some((option) => option.id === binding.primary);
            const addable = options.filter((option) => option.id !== binding.primary && !fallbacks.includes(option.id));
            return (
              <section className={`model-routing-tier-card${missingPrimary ? ' is-warning' : ''}`} key={tier} aria-label={tierLabel}>
                <header className="model-routing-tier-head">
                  <span className="model-routing-tier-badge" aria-hidden="true">
                    <PeerIcon name={meta.icon} size={14} />
                  </span>
                  <div className="model-routing-tier-copy">
                    <div className="model-routing-tier-title-row">
                      <span className="model-routing-name">{tierLabel}</span>
                      {missingPrimary ? (
                        <span className="model-routing-status-tag is-warn">
                          {isZh ? '需重选' : 'Unavailable'}
                        </span>
                      ) : fallbacks.length > 0 ? (
                        <span className="model-routing-status-tag">
                          {i18n.t('modelRouting.fallbacks')} {fallbacks.length}
                        </span>
                      ) : null}
                    </div>
                    <p className="model-routing-tier-desc">{isZh ? meta.zh : meta.en}</p>
                  </div>
                </header>

                <div className="model-routing-tier-fields">
                  <div className="model-routing-field">
                    <span className="model-routing-field-label">{i18n.t('modelRouting.primary')}</span>
                    <RoutingModelPicker
                      value={binding.primary}
                      options={options}
                      target={{ kind: 'tier', tier }}
                      disabled={readOnly}
                      ariaLabel={tierLabel}
                      i18n={i18n}
                      onChange={(id) => save(tierPatch(tier, id, withoutId(fallbacks, id), binding))}
                    />
                  </div>

                  <RoutingParameterFields
                    value={binding}
                    candidates={routingParameterCandidates({ mode: 'tier', tier }, view.routing.tiers, options, { kind: 'tier', tier })}
                    disabled={readOnly} label={tierLabel} i18n={i18n}
                    onEffort={effort => {
                      const { reasoningEffort: _old, ...rest } = binding;
                      void save({ tiers: { [tier]: { ...rest, ...(effort != null ? { reasoningEffort: effort } : {}) } } });
                    }}
                    onChannel={fastMode => { void save({ tiers: { [tier]: { ...binding, fastMode } } }); }}
                  />

                  <div className="model-routing-field">
                    <span className="model-routing-field-label">{i18n.t('modelRouting.fallbacks')}</span>
                    <div className="model-routing-fallbacks">
                      {fallbacks.map((id, index) => {
                        const label = options.find((option) => option.id === id)?.label || i18n.t('modelRouting.modelUnavailable');
                        return (
                          <span className="model-routing-chip" key={id}>
                            <span className="model-routing-chip__label" title={label}>{label}</span>
                            <span className="model-routing-chip__actions">
                              <button
                                type="button"
                                disabled={readOnly || index === 0}
                                aria-label={i18n.t('modelRouting.moveUp')}
                                onClick={() => save(tierPatch(tier, binding.primary, moveListItem(fallbacks, id, -1), binding))}
                              >
                                <PeerIcon name="chevronUp" size={12} />
                              </button>
                              <button
                                type="button"
                                disabled={readOnly || index === fallbacks.length - 1}
                                aria-label={i18n.t('modelRouting.moveDown')}
                                onClick={() => save(tierPatch(tier, binding.primary, moveListItem(fallbacks, id, 1), binding))}
                              >
                                <PeerIcon name="chevronDown" size={12} />
                              </button>
                              <button
                                type="button"
                                disabled={readOnly}
                                aria-label={i18n.t('modelRouting.remove')}
                                onClick={() => save(tierPatch(tier, binding.primary, withoutId(fallbacks, id), binding))}
                              >
                                <PeerIcon name="close" size={12} />
                              </button>
                            </span>
                          </span>
                        );
                      })}
                      <RoutingModelPicker
                        className="is-fallback-add"
                        value=""
                        options={addable}
                        target={{ kind: 'tier', tier }}
                        disabled={readOnly || addable.length === 0}
                        placeholder={`+ ${i18n.t('modelRouting.addFallback')}`}
                        ariaLabel={i18n.t('modelRouting.addFallback')}
                        i18n={i18n}
                        onChange={(id) => save(tierPatch(tier, binding.primary, [...fallbacks, id], binding))}
                      />
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      </SettingsGroup>

      <SettingsGroup className="model-routing-card" title={i18n.t('modelRouting.roles')}>
        <div className="model-routing-pref">
          <div className="model-routing-pref-copy">
            <span id={preferLabelId} className="model-routing-pref-title">{i18n.t('modelRouting.preferDifferentFamily')}</span>
            <p className="model-routing-pref-desc">
              {i18n.locale.startsWith('zh')
                ? '执行与复核尽量使用不同模型家族，减少同源盲区。'
                : 'Prefer a different model family for verification to reduce blind spots.'}
            </p>
          </div>
          <Switch
            checked={view.routing.verifierPreferDifferentFamily !== false}
            disabled={readOnly}
            aria-labelledby={preferLabelId}
            onCheckedChange={(checked) => save({ verifierPreferDifferentFamily: checked })}
          />
        </div>
        <div className="model-routing-role-list">
          {MODEL_ROLES.map((role) => {
            const setting: RoleSetting = view.routing.roles[role] || { mode: 'tier', tier: 'economy' };
            const resolved = resolutionFor(role);
            const roleLabel = i18n.t(roleTranslationKey(role) || 'modelRouting.unresolved');
            // Preview describes the saved route; a pending draft must not relabel it.
            const savedRouting = preview?.routing ?? form.saved?.view.routing ?? view.routing;
            const savedSetting = savedRouting.roles[role] ?? { mode: 'tier' as const, tier: 'economy' as const };
            const resolvedLabel = resolutionText(resolved, role, i18n, savedSetting, previewError);
            const resolvedCompact = resolvedLabel.replace(/\n+/g, ' · ');
            const resolvedTone = !resolved ? 'pending' : resolved.ok && !resolved.spendExceeded ? 'ok' : 'warn';
            const parameters = { reasoningEffort: setting.reasoningEffort, fastMode: setting.fastMode };
            return (
              <div className={`model-routing-role-item${setting.mode === 'auto' ? ' is-auto' : ''}`} key={role}>
                <div className="model-routing-role-head">
                  <div className="model-routing-name">{roleLabel}</div>
                  <div
                    className={`model-routing-resolved-pill is-${resolvedTone}`}
                    title={resolvedLabel}
                  >
                    <span className="model-routing-resolved-dot" aria-hidden="true" />
                    <span className="model-routing-resolved-text">{resolvedCompact}</span>
                  </div>
                </div>
                <div className="model-routing-role-controls">
                  <div className="model-routing-field">
                    <span className="model-routing-field-label">{i18n.t('modelRouting.modeLabel')}</span>
                    <Dropdown
                      value={setting.mode}
                      disabled={readOnly}
                      ariaLabel={`${roleLabel} ${i18n.t('modelRouting.modeLabel')}`}
                      options={[
                        { value: 'tier', label: i18n.t('modelRouting.mode.tier') },
                        { value: 'fixed', label: i18n.t('modelRouting.mode.fixed') },
                        { value: 'auto', label: i18n.t('modelRouting.mode.auto') },
                      ]}
                      onChange={(mode) => {
                        if (mode === 'tier') {
                          void save(rolePatch(role, { mode: 'tier', tier: setting.mode === 'tier' ? setting.tier : 'economy', ...parameters }));
                        } else if (mode === 'fixed') {
                          const capable = options.find((option) => !optionRejectReason(option, { kind: 'role', role }));
                          if (!capable) {
                            setError(i18n.t('modelRouting.poolInvalid'));
                            return;
                          }
                          void save(rolePatch(role, { mode: 'fixed', modelProviderId: capable.id, ...parameters }));
                        } else {
                          const capable = options.filter((option) => !optionRejectReason(option, { kind: 'role', role }));
                          const pool = capable.slice(0, 1).map((option) => option.id);
                          const check = validateAutoPool(pool, options, role);
                          if (!check.ok) {
                            setError(i18n.t('modelRouting.poolInvalid'));
                            return;
                          }
                          void save(rolePatch(role, { mode: 'auto', pool, ...parameters }));
                        }
                      }}
                    />
                  </div>
                  <div className="model-routing-field">
                    <span className="model-routing-field-label">{i18n.t('modelRouting.targetLabel')}</span>
                    {setting.mode === 'tier' ? (
                      <Dropdown
                        value={setting.tier}
                        disabled={readOnly}
                        ariaLabel={`${roleLabel} ${i18n.t('modelRouting.tiers')}`}
                        options={MODEL_TIERS.map((tierName) => ({
                          value: tierName,
                          label: i18n.t(tierTranslationKey(tierName)),
                        }))}
                        onChange={(tierName) => save(rolePatch(role, { ...setting, tier: tierName as ModelTierName }))}
                      />
                    ) : null}
                    {setting.mode === 'fixed' ? (
                      <RoutingModelPicker
                        value={setting.modelProviderId}
                        options={options}
                        target={{ kind: 'role', role }}
                        disabled={readOnly}
                        ariaLabel={roleLabel}
                        i18n={i18n}
                        onChange={(id) => save(rolePatch(role, { ...setting, modelProviderId: id }))}
                      />
                    ) : null}
                    {setting.mode === 'auto' ? (
                      <ModelPicker className="model-routing-model-menu" variant="field" selectedModelIds={setting.pool || []}
                        groups={selectionGroupsFromMenuGroups(routingMenuGroups(options, { kind: 'role', role },
                          i18n.locale.startsWith('zh'), reason => i18n.t(reasonTranslationKey(reason))))}
                        selectionDisabled={readOnly} busy={form.saving} isZh={i18n.locale.startsWith('zh')}
                        label={(setting.pool || []).map(id => options.find(option => option.id === id)?.label
                          ?? i18n.t('modelRouting.modelUnavailable')).join(' / ') || i18n.t('modelRouting.chooseModel')}
                        ariaLabel={roleLabel}
                        onSelectModel={id => {
                          const pool = (setting.pool || []).includes(id) ? withoutId(setting.pool || [], id) : [...(setting.pool || []), id];
                          const check = validateAutoPool(pool, options, role);
                          if (!check.ok) { setError(i18n.t('modelRouting.poolInvalid')); return; }
                          return save(rolePatch(role, { ...setting, pool }));
                        }} />
                    ) : null}
                  </div>
                  <RoutingParameterFields
                    value={setting}
                    candidates={routingParameterCandidates(setting, view.routing.tiers, options, { kind: 'role', role })}
                    inherit={setting.mode === 'tier' ? routingParameters({ mode: 'tier', tier: setting.tier }, view.routing.tiers) : undefined}
                    disabled={readOnly} label={roleLabel} i18n={i18n}
                    onEffort={effort => { void save(rolePatch(role, setRoutingReasoning(setting, effort))); }}
                    onChannel={fast => {
                      const { fastMode: _old, ...rest } = setting;
                      void save(rolePatch(role, { ...rest, ...(fast !== undefined ? { fastMode: fast } : {}) }));
                    }}
                  />
                  <label className="model-routing-field model-routing-spend">
                    <span className="model-routing-field-label">{i18n.t('modelRouting.spendCap')}</span>
                    <span className="model-routing-spend-wrap">
                      <span className="model-routing-spend-prefix" aria-hidden="true">$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="—"
                        disabled={readOnly}
                        aria-label={i18n.t('modelRouting.spendCap')}
                        value={form.draft?.caps[role] ?? ''}
                        aria-invalid={form.saveError || Boolean(error) || undefined}
                        onChange={event => { if (form.draft) form.edit({ ...form.draft, caps: { ...form.draft.caps, [role]: event.target.value } }); }}
                        onBlur={() => { if (form.dirty && !form.saving) void form.save(); }}
                      />
                    </span>
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      </SettingsGroup>
    </div>
  );
}

function resolutionText(row: ModelRoutingPreviewRow | undefined, role: ModelRoleName, i18n: I18nRuntime, setting: RoleSetting, previewError: boolean) {
  if (!row) return i18n.t(previewError ? 'forms.previewFailed' : 'settings.usage.loading');
  const relation = setting.mode === 'tier'
    ? `${i18n.t('modelRouting.followingTier', { tier: i18n.t(tierTranslationKey(setting.tier)) })}\n` : '';
  const label = row.ok ? `${row.label} · ${isModelReasoningEffort(row.reasoningEffort)
    ? effortLabel(row.reasoningEffort, i18n.locale.startsWith('zh')) : i18n.t('modelRouting.reasoningDefault')} · ${i18n.t(row.fastMode ? 'modelRouting.channelFast' : 'modelRouting.channelNormal')}` : row.label;
  if (row.ok && row.spendExceeded && isEssentialRole(role)) {
    return `${relation}${label} · ${i18n.t('modelRouting.essentialSpend')}`;
  }
  if (!row.ok && row.reason === 'spend_cap_reached') return `${relation}${i18n.t('modelRouting.spendExceeded')}`;
  if (!row.ok && row.reason === 'fast_mode') return `${relation}${i18n.t('modelRouting.fastUnsupported')}`;
  if (!row.ok && row.reason === 'reasoning') return `${relation}${i18n.t('modelRouting.reasoningInvalid')}`;
  if (!row.ok) return `${relation}${i18n.t(setting.mode === 'tier' ? 'modelRouting.checkTier' : setting.mode === 'fixed' ? 'modelRouting.checkFixed' : 'modelRouting.poolInvalid')}`;
  return `${relation}${label}`;
}

function RoutingModelPicker({
  className,
  value,
  options,
  target,
  disabled,
  placeholder,
  ariaLabel,
  i18n,
  onChange,
}: {
  readonly className?: string;
  readonly value: string;
  readonly options: readonly RoutingModelOption[];
  readonly target: { readonly kind: 'tier'; readonly tier: ModelTierName } | { readonly kind: 'role'; readonly role: ModelRoleName };
  readonly disabled: boolean;
  readonly placeholder?: string;
  readonly ariaLabel: string;
  readonly i18n: I18nRuntime;
  readonly onChange: (id: string) => void;
}) {
  const groups = routingMenuGroups(
    options,
    target,
    i18n.locale === 'zh-CN',
    (reason) => i18n.t(reasonTranslationKey(reason)),
  );
  const missing = Boolean(value) && !options.some(option => option.id === value);
  return (
    <ModelPicker
      className={['model-routing-model-menu', missing ? 'is-missing' : '', className ?? ''].filter(Boolean).join(' ')}
      variant="field"
      selectedModelId={value} groups={selectionGroupsFromMenuGroups(groups)}
      selectionDisabled={disabled} isZh={i18n.locale.startsWith('zh')}
      label={missing ? i18n.t('modelRouting.modelUnavailable') : options.find(option => option.id === value)?.label
        ?? placeholder ?? i18n.t('modelRouting.chooseModel')}
      ariaLabel={missing ? `${ariaLabel}: ${i18n.t('modelRouting.modelUnavailable')}` : ariaLabel}
      onSelectModel={onChange} />
  );
}
