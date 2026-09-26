import type { I18nRuntime } from '@peer-agent/i18n';
import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../../clientApi';
import type {
  ModelRoutingPatch,
  ModelRoutingPreviewRow,
  ModelRoutingProviderOption,
  ModelRoutingView,
} from '../../../preload/contracts/bootstrapPreloadApi';
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

  if (loading && !view) return <p className="settings-status">{i18n.t('settings.usage.loading')}</p>;
  if (!view) return <p className="settings-status">{error || i18n.t('modelRouting.loadFailed')}</p>;

  const options = asOptions(view.providers);
  const readOnly = isRoutingReadOnly(options.length);
  const resolutionFor = (role: string) => resolutions.find((row) => row.role === role);

  return (
    <div className="settings-panel model-routing-panel">
      <header className="settings-panel__header">
        <h2>{i18n.t('modelRouting.title')}</h2>
        <p>{i18n.t('modelRouting.description')}</p>
      </header>
      {options.length === 1 ? <p className="model-routing-banner">{i18n.t('modelRouting.singleModel')}</p> : null}
      {options.length === 0 ? <p className="model-routing-banner">{i18n.t('modelRouting.noModel')}</p> : null}
      {error ? <p className="settings-warning">{error}</p> : null}

      <section className="settings-card">
        <h3>{i18n.t('modelRouting.tiers')}</h3>
        <table className="model-routing-table">
          <thead>
            <tr>
              <th>{i18n.t('modelRouting.tiers')}</th>
              <th>{i18n.t('modelRouting.primary')}</th>
              <th>{i18n.t('modelRouting.fallbacks')}</th>
            </tr>
          </thead>
          <tbody>
            {MODEL_TIERS.map((tier) => {
              const binding = view.routing.tiers[tier] || { primary: '', fallbacks: [] };
              const fallbacks = binding.fallbacks || [];
              return (
                <tr key={tier}>
                  <th scope="row">{i18n.t(tierTranslationKey(tier))}</th>
                  <td>
                    <ModelSelect
                      value={binding.primary}
                      options={options}
                      target={{ kind: 'tier', tier }}
                      disabled={readOnly}
                      i18n={i18n}
                      onChange={(id) => save(tierPatch(tier, id, withoutId(fallbacks, id)))}
                    />
                  </td>
                  <td>
                    <div className="model-routing-fallbacks">
                      {fallbacks.map((id) => (
                        <div className="model-routing-fallback" key={id}>
                          <span>{options.find((option) => option.id === id)?.label || id}</span>
                          <button type="button" disabled={readOnly} onClick={() => save(tierPatch(tier, binding.primary, moveListItem(fallbacks, id, -1)))}>{i18n.t('modelRouting.moveUp')}</button>
                          <button type="button" disabled={readOnly} onClick={() => save(tierPatch(tier, binding.primary, moveListItem(fallbacks, id, 1)))}>{i18n.t('modelRouting.moveDown')}</button>
                          <button type="button" disabled={readOnly} onClick={() => save(tierPatch(tier, binding.primary, withoutId(fallbacks, id)))}>{i18n.t('modelRouting.remove')}</button>
                        </div>
                      ))}
                      <ModelSelect
                        value=""
                        options={options.filter((option) => option.id !== binding.primary && !fallbacks.includes(option.id))}
                        target={{ kind: 'tier', tier }}
                        disabled={readOnly}
                        placeholder={i18n.t('modelRouting.addFallback')}
                        i18n={i18n}
                        onChange={(id) => save(tierPatch(tier, binding.primary, [...fallbacks, id]))}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="settings-card">
        <h3>{i18n.t('modelRouting.roles')}</h3>
        <label className="model-routing-fallback">
          <input
            type="checkbox"
            checked={view.routing.verifierPreferDifferentFamily !== false}
            disabled={readOnly}
            onChange={(event) => save({ verifierPreferDifferentFamily: event.target.checked })}
          />
          {i18n.t('modelRouting.preferDifferentFamily')}
        </label>
        <table className="model-routing-table">
          <thead>
            <tr>
              <th>{i18n.t('modelRouting.roles')}</th>
              <th>{i18n.t('modelRouting.mode.tier')}</th>
              <th>{i18n.t('modelRouting.resolved')}</th>
              <th>{i18n.t('modelRouting.spendCap')}</th>
            </tr>
          </thead>
          <tbody>
            {MODEL_ROLES.map((role) => {
              const setting = view.routing.roles[role] || { mode: 'tier', tier: 'economy' };
              const resolved = resolutionFor(role);
              return (
                <tr key={role}>
                  <th scope="row">{i18n.t(roleTranslationKey(role) || 'modelRouting.unresolved')}</th>
                  <td>
                    <select
                      value={setting.mode}
                      disabled={readOnly}
                      aria-label={i18n.t(roleTranslationKey(role) || 'modelRouting.unresolved')}
                      onChange={(event) => {
                        const mode = event.target.value;
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
                    >
                      <option value="tier">{i18n.t('modelRouting.mode.tier')}</option>
                      <option value="fixed">{i18n.t('modelRouting.mode.fixed')}</option>
                      <option value="auto">{i18n.t('modelRouting.mode.auto')}</option>
                    </select>
                    {setting.mode === 'tier' ? (
                      <select
                        value={setting.tier}
                        disabled={readOnly}
                        onChange={(event) => save(rolePatch(role, { mode: 'tier', tier: event.target.value as ModelTierName }))}
                      >
                        {MODEL_TIERS.map((tierName) => <option key={tierName} value={tierName}>{i18n.t(tierTranslationKey(tierName))}</option>)}
                      </select>
                    ) : null}
                    {setting.mode === 'fixed' ? (
                      <ModelSelect
                        value={setting.modelProviderId}
                        options={options}
                        target={{ kind: 'role', role }}
                        disabled={readOnly}
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
                            <label key={option.id}>
                              <input
                                type="checkbox"
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
                  </td>
                  <td className="model-routing-resolved">{resolutionText(resolved, role, i18n)}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
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
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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

function ModelSelect({
  value,
  options,
  target,
  disabled,
  placeholder,
  i18n,
  onChange,
}: {
  readonly value: string;
  readonly options: readonly RoutingModelOption[];
  readonly target: { readonly kind: 'tier'; readonly tier: ModelTierName } | { readonly kind: 'role'; readonly role: ModelRoleName };
  readonly disabled: boolean;
  readonly placeholder?: string;
  readonly i18n: I18nRuntime;
  readonly onChange: (id: string) => void;
}) {
  return (
    <select value={value} disabled={disabled} onChange={(event) => { if (event.target.value) onChange(event.target.value); }}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((option) => {
        const reason = optionRejectReason(option, target);
        return (
          <option key={option.id} value={option.id} disabled={Boolean(reason)}>
            {optionLabel(option, reason, i18n)}
          </option>
        );
      })}
    </select>
  );
}
