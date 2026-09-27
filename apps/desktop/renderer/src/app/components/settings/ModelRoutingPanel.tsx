import type { I18nRuntime } from '@peer-agent/i18n';
import { useCallback, useEffect, useId, useState } from 'react';
import { clientApi } from '../../../clientApi';
import type {
  ModelRoutingPatch,
  ModelRoutingPreviewRow,
  ModelRoutingProviderOption,
  ModelRoutingView,
} from '../../../preload/contracts/bootstrapPreloadApi';
import { Checkbox, Switch } from '../../../ui/boolean-controls';
import { Dropdown } from '../Dropdown';
import './model-routing.css';
import {
  MODEL_ROLES,
  MODEL_TIERS,
  isEssentialRole,
  isRoutingReadOnly,
  moveListItem,
  optionRejectReason,
  reasonTranslationKey,
  roleTranslationKey,
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
    supportsVision: provider.supportsVision,
    supportsTools: provider.supportsTools,
    supportsStructured: provider.supportsStructured,
    contextTokens: provider.contextTokens,
  }));
}

function optionLabel(option: RoutingModelOption, reason: ReturnType<typeof optionRejectReason>, i18n: I18nRuntime) {
  return reason ? `${option.label} — ${i18n.t(reasonTranslationKey(reason))}` : option.label;
}

function tierPatch(tier: ModelTierName, primary: string, fallbacks: readonly string[]): ModelRoutingPatch {
  const tiers: NonNullable<ModelRoutingPatch['tiers']> = {};
  tiers[tier] = { primary, fallbacks };
  return { tiers };
}

function rolePatch(role: ModelRoleName, setting: NonNullable<ModelRoutingPatch['roles']>[ModelRoleName]): ModelRoutingPatch {
  const roles: NonNullable<ModelRoutingPatch['roles']> = {};
  if (setting) roles[role] = setting;
  return { roles };
}

function capPatch(role: ModelRoleName, amount: number | null): ModelRoutingPatch {
  const roleSpendCaps: NonNullable<ModelRoutingPatch['roleSpendCaps']> = {};
  roleSpendCaps[role] = amount;
  return { roleSpendCaps };
}

export function ModelRoutingPanel({ i18n }: { readonly i18n: I18nRuntime }) {
  const [view, setView] = useState<ModelRoutingView | null>(null);
  const [resolutions, setResolutions] = useState<readonly ModelRoutingPreviewRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const preferLabelId = useId();

  const reload = useCallback(async () => {
    const [next, preview] = await Promise.all([
      clientApi.modelRoutingGet(),
      clientApi.modelRoutingPreview(),
    ]);
    setView(next);
    setResolutions(preview.resolutions);
  }, []);

  useEffect(() => {
    let cancelled = false;
    reload()
      .catch(() => {
        if (!cancelled) setError(i18n.t('modelRouting.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [i18n, reload]);

  async function save(partial: ModelRoutingPatch) {
    if (!view || isRoutingReadOnly(view.providers.length)) return;
    setError('');
    try {
      await clientApi.modelRoutingUpdate(partial);
      await reload();
    } catch {
      setError(i18n.t('modelRouting.saveFailed'));
    }
  }

  if (loading && !view) {
    return (
      <div className="settings-panel model-routing-panel">
        <p className="settings-status">{i18n.t('settings.usage.loading')}</p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="settings-panel model-routing-panel">
        <p className="settings-status">{error || i18n.t('modelRouting.loadFailed')}</p>
      </div>
    );
  }

  const options = asOptions(view.providers);
  const readOnly = isRoutingReadOnly(options.length);
  const resolutionFor = (role: string) => resolutions.find((row) => row.role === role);

  return (
    <div className="settings-panel model-routing-panel">
      <header className="model-routing-header">
        <h2>{i18n.t('modelRouting.title')}</h2>
        <p>{i18n.t('modelRouting.description')}</p>
      </header>
      {options.length === 1 ? <p className="model-routing-banner">{i18n.t('modelRouting.singleModel')}</p> : null}
      {options.length === 0 ? <p className="model-routing-banner">{i18n.t('modelRouting.noModel')}</p> : null}
      {error ? <p className="settings-warning">{error}</p> : null}

      <section className="settings-card model-routing-card">
        <h3>{i18n.t('modelRouting.tiers')}</h3>
        <div className="model-routing-head model-routing-tier" aria-hidden="true">
          <span />
          <span>{i18n.t('modelRouting.primary')}</span>
          <span>{i18n.t('modelRouting.fallbacks')}</span>
        </div>
        <div>
          {MODEL_TIERS.map((tier) => {
            const binding = view.routing.tiers[tier] || { primary: '', fallbacks: [] };
            const fallbacks = binding.fallbacks || [];
            const tierLabel = i18n.t(tierTranslationKey(tier));
            const addable = options.filter((option) => option.id !== binding.primary && !fallbacks.includes(option.id));
            return (
              <div className="model-routing-row model-routing-tier" key={tier}>
                <div className="model-routing-name">{tierLabel}</div>
                <ModelDropdown
                  value={binding.primary}
                  options={options}
                  target={{ kind: 'tier', tier }}
                  disabled={readOnly}
                  ariaLabel={tierLabel}
                  i18n={i18n}
                  onChange={(id) => save(tierPatch(tier, id, withoutId(fallbacks, id)))}
                />
                <div className="model-routing-fallbacks">
                  {fallbacks.map((id, index) => (
                    <span className="model-routing-chip" key={id}>
                      <span className="model-routing-chip__label">{options.find((option) => option.id === id)?.label || id}</span>
                      <span className="model-routing-chip__actions">
                        <button
                          type="button"
                          disabled={readOnly || index === 0}
                          aria-label={i18n.t('modelRouting.moveUp')}
                          onClick={() => save(tierPatch(tier, binding.primary, moveListItem(fallbacks, id, -1)))}
                        >
                          <Chevron direction="up" />
                        </button>
                        <button
                          type="button"
                          disabled={readOnly || index === fallbacks.length - 1}
                          aria-label={i18n.t('modelRouting.moveDown')}
                          onClick={() => save(tierPatch(tier, binding.primary, moveListItem(fallbacks, id, 1)))}
                        >
                          <Chevron direction="down" />
                        </button>
                        <button
                          type="button"
                          disabled={readOnly}
                          aria-label={i18n.t('modelRouting.remove')}
                          onClick={() => save(tierPatch(tier, binding.primary, withoutId(fallbacks, id)))}
                        >
                          <RemoveIcon />
                        </button>
                      </span>
                    </span>
                  ))}
                  <ModelDropdown
                    value=""
                    options={addable}
                    target={{ kind: 'tier', tier }}
                    disabled={readOnly || addable.length === 0}
                    placeholder={i18n.t('modelRouting.addFallback')}
                    ariaLabel={i18n.t('modelRouting.addFallback')}
                    i18n={i18n}
                    onChange={(id) => save(tierPatch(tier, binding.primary, [...fallbacks, id]))}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="settings-card model-routing-card">
        <h3>{i18n.t('modelRouting.roles')}</h3>
        <div className="model-routing-pref">
          <span id={preferLabelId}>{i18n.t('modelRouting.preferDifferentFamily')}</span>
          <Switch
            checked={view.routing.verifierPreferDifferentFamily !== false}
            disabled={readOnly}
            aria-labelledby={preferLabelId}
            onCheckedChange={(checked) => save({ verifierPreferDifferentFamily: checked })}
          />
        </div>
        <div className="model-routing-head model-routing-role" aria-hidden="true">
          <span />
          <span />
          <span />
          <span>{i18n.t('modelRouting.resolved')}</span>
          <span>{i18n.t('modelRouting.spendCap')}</span>
        </div>
        <div>
          {MODEL_ROLES.map((role) => {
            const setting = view.routing.roles[role] || { mode: 'tier', tier: 'economy' };
            const resolved = resolutionFor(role);
            const roleLabel = i18n.t(roleTranslationKey(role) || 'modelRouting.unresolved');
            const resolvedLabel = resolutionText(resolved, role, i18n);
            return (
              <div className={`model-routing-row model-routing-role${setting.mode === 'auto' ? ' is-auto' : ''}`} key={role}>
                <div className="model-routing-name">{roleLabel}</div>
                <Dropdown
                  value={setting.mode}
                  disabled={readOnly}
                  ariaLabel={roleLabel}
                  options={[
                    { value: 'tier', label: i18n.t('modelRouting.mode.tier') },
                    { value: 'fixed', label: i18n.t('modelRouting.mode.fixed') },
                    { value: 'auto', label: i18n.t('modelRouting.mode.auto') },
                  ]}
                  onChange={(mode) => {
                    if (mode === 'tier') {
                      void save(rolePatch(role, { mode: 'tier', tier: setting.mode === 'tier' ? setting.tier : 'economy' }));
                    } else if (mode === 'fixed') {
                      const capable = options.find((option) => !optionRejectReason(option, { kind: 'role', role }));
                      if (!capable) {
                        setError(i18n.t('modelRouting.poolInvalid'));
                        return;
                      }
                      void save(rolePatch(role, { mode: 'fixed', modelProviderId: capable.id }));
                    } else {
                      const capable = options.filter((option) => !optionRejectReason(option, { kind: 'role', role }));
                      const pool = capable.slice(0, 1).map((option) => option.id);
                      const check = validateAutoPool(pool, options, role);
                      if (!check.ok) {
                        setError(i18n.t('modelRouting.poolInvalid'));
                        return;
                      }
                      void save(rolePatch(role, { mode: 'auto', pool }));
                    }
                  }}
                />
                {setting.mode === 'tier' ? (
                  <Dropdown
                    value={setting.tier}
                    disabled={readOnly}
                    ariaLabel={`${roleLabel} ${i18n.t('modelRouting.tiers')}`}
                    options={MODEL_TIERS.map((tierName) => ({
                      value: tierName,
                      label: i18n.t(tierTranslationKey(tierName)),
                    }))}
                    onChange={(tierName) => save(rolePatch(role, { mode: 'tier', tier: tierName as ModelTierName }))}
                  />
                ) : null}
                {setting.mode === 'fixed' ? (
                  <ModelDropdown
                    value={setting.modelProviderId}
                    options={options}
                    target={{ kind: 'role', role }}
                    disabled={readOnly}
                    ariaLabel={roleLabel}
                    i18n={i18n}
                    onChange={(id) => save(rolePatch(role, { mode: 'fixed', modelProviderId: id }))}
                  />
                ) : null}
                {setting.mode === 'auto' ? (
                  <div className="model-routing-pool">
                    {options.map((option) => {
                      const reason = optionRejectReason(option, { kind: 'role', role });
                      const checked = (setting.pool || []).includes(option.id);
                      return (
                        <label className="model-routing-pool-item" key={option.id}>
                          <Checkbox
                            checked={checked}
                            disabled={readOnly || Boolean(reason)}
                            onChange={() => {
                              const pool = checked ? withoutId(setting.pool || [], option.id) : [...(setting.pool || []), option.id];
                              const check = validateAutoPool(pool, options, role);
                              if (!check.ok) {
                                setError(i18n.t('modelRouting.poolInvalid'));
                                return;
                              }
                              setError('');
                              void save(rolePatch(role, { mode: 'auto', pool }));
                            }}
                          />
                          {optionLabel(option, reason, i18n)}
                        </label>
                      );
                    })}
                  </div>
                ) : null}
                <div className="model-routing-resolved" data-label={i18n.t('modelRouting.resolved')} title={resolvedLabel}>
                  {resolvedLabel}
                </div>
                <label className="model-routing-spend" data-label={i18n.t('modelRouting.spendCap')}>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="—"
                    disabled={readOnly}
                    aria-label={i18n.t('modelRouting.spendCap')}
                    defaultValue={view.routing.roleSpendCaps?.[role] ?? ''}
                    key={`${role}:${view.routing.roleSpendCaps?.[role] ?? ''}`}
                    onBlur={(event) => {
                      const raw = event.target.value.trim();
                      const previous = view.routing.roleSpendCaps?.[role];
                      if (raw === '') {
                        if (previous == null) return;
                        void save(capPatch(role, null));
                        return;
                      }
                      const amount = Number(raw);
                      if (!Number.isFinite(amount) || amount < 0 || amount === previous) return;
                      void save(capPatch(role, amount));
                    }}
                  />
                </label>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function resolutionText(row: ModelRoutingPreviewRow | undefined, role: ModelRoleName, i18n: I18nRuntime) {
  if (!row) return i18n.t('modelRouting.unresolved');
  if (row.spendExceeded && isEssentialRole(role)) {
    return `${row.label} · ${i18n.t('modelRouting.essentialSpend')}`;
  }
  if (!row.ok && row.reason === 'spend_cap_reached') return i18n.t('modelRouting.spendExceeded');
  if (!row.ok) return i18n.t('modelRouting.unresolved');
  return row.label;
}

function ModelDropdown({
  value,
  options,
  target,
  disabled,
  placeholder,
  ariaLabel,
  i18n,
  onChange,
}: {
  readonly value: string;
  readonly options: readonly RoutingModelOption[];
  readonly target: { readonly kind: 'tier'; readonly tier: ModelTierName } | { readonly kind: 'role'; readonly role: ModelRoleName };
  readonly disabled: boolean;
  readonly placeholder?: string;
  readonly ariaLabel: string;
  readonly i18n: I18nRuntime;
  readonly onChange: (id: string) => void;
}) {
  return (
    <Dropdown
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      onChange={(next) => {
        if (next) onChange(next);
      }}
      options={options.map((option) => {
        const reason = optionRejectReason(option, target);
        return {
          value: option.id,
          label: option.label,
          hint: reason ? i18n.t(reasonTranslationKey(reason)) : undefined,
          disabled: Boolean(reason),
        };
      })}
    />
  );
}

function Chevron({ direction }: { readonly direction: 'up' | 'down' }) {
  return (
    <svg
      className={direction === 'up' ? 'model-routing-icon model-routing-icon--up' : 'model-routing-icon'}
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function RemoveIcon() {
  return (
    <svg
      className="model-routing-icon"
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
