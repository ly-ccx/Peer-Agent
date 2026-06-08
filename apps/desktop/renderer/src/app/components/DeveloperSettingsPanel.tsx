import type { I18nRuntime } from '@zeus-atlas/i18n';
import type {
  AuthState,
  CloudEndpointMode,
  CloudContractProbeReport,
  DeveloperDiagnostics,
  DeveloperSettings,
  DeveloperSettingsState,
} from '@zeus-atlas/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';

const PRE_GATEWAY_URL = 'https://pre-cbu-xiaoer-service.alibaba-inc.com';

function modeLabel(i18n: I18nRuntime, mode: CloudEndpointMode) {
  if (mode === 'pre') return i18n.t('runtime.mode.pre');
  if (mode === 'custom') return i18n.t('runtime.mode.custom');
  return i18n.t('runtime.mode.prod');
}

function normalizeForm(settings: DeveloperSettings): DeveloperSettings {
  return {
    developerMode: Boolean(settings.developerMode),
    cloudMode: settings.cloudMode ?? (settings.developerMode ? 'pre' : 'prod'),
    gatewayUrl: settings.gatewayUrl ?? '',
    streamUrl: settings.streamUrl ?? '',
    runtimeGatewayUrl: settings.runtimeGatewayUrl ?? '',
    updatedAt: settings.updatedAt,
  };
}

function requestLine(diagnostics: DeveloperDiagnostics | null) {
  const request = diagnostics?.lastRequest;
  if (!request) return null;
  return [
    request.method,
    request.path,
    request.status ? String(request.status) : request.error,
  ].filter(Boolean).join(' · ');
}

function authStatusLabel(authState: AuthState | null, i18n: I18nRuntime) {
  if (authState?.status === 'authenticated') {
    return authState.user?.empId || authState.user?.account || authState.user?.name || i18n.t('auth.authenticated');
  }
  if (authState?.status === 'not_configured') return i18n.t('auth.not_configured');
  if (authState?.status === 'signing_in') return i18n.t('auth.signing_in');
  if (authState?.status === 'error') return i18n.t('auth.error');
  return i18n.t('auth.signed_out');
}

function developerErrorMessage(error: unknown, fallback: string, i18n: I18nRuntime) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/No handler registered for ['"]developer-settings:/.test(message)) {
    return i18n.t('developer.ipcUnavailable');
  }
  return message || fallback;
}

export function DeveloperSettingsPanel({
  authState,
  i18n,
  onApplied,
  onBack,
}: {
  readonly authState: AuthState | null;
  readonly i18n: I18nRuntime;
  readonly onApplied: () => Promise<void> | void;
  readonly onBack?: () => void;
}) {
  const [state, setState] = useState<DeveloperSettingsState | null>(null);
  const [form, setForm] = useState<DeveloperSettings | null>(null);
  const [diagnostics, setDiagnostics] = useState<DeveloperDiagnostics | null>(null);
  const [probeReport, setProbeReport] = useState<CloudContractProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);

  const loadState = useCallback(async () => {
    const [settingsState, nextDiagnostics] = await Promise.all([
      clientApi.getDeveloperSettings(),
      clientApi.getDeveloperDiagnostics(),
    ]);
    setState(settingsState);
    setForm(normalizeForm(settingsState.settings));
    setDiagnostics(nextDiagnostics);
  }, []);

  useEffect(() => {
    void loadState().catch((nextError: unknown) => {
      setError(developerErrorMessage(nextError, i18n.t('developer.loadFailed'), i18n));
    });
  }, [i18n, loadState]);

  const effective = state?.effectiveConfig;
  const currentModeLabel = effective ? modeLabel(i18n, effective.mode) : i18n.t('status.connecting');
  const gatewayPlaceholder = form?.cloudMode === 'pre' ? PRE_GATEWAY_URL : 'https://example.alibaba-inc.com';
  const streamPlaceholder = form?.cloudMode === 'pre' ? PRE_GATEWAY_URL : gatewayPlaceholder;
  const authLabel = useMemo(() => authStatusLabel(authState, i18n), [authState, i18n]);

  const updateForm = (patch: Partial<DeveloperSettings>) => {
    setForm((current) => {
      const base = current ?? normalizeForm({
        developerMode: false,
        cloudMode: 'prod',
      });
      return { ...base, ...patch };
    });
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const nextState = await clientApi.updateDeveloperSettings({
        ...form,
        gatewayUrl: form.gatewayUrl?.trim() || undefined,
        streamUrl: form.streamUrl?.trim() || undefined,
        runtimeGatewayUrl: form.runtimeGatewayUrl?.trim() || undefined,
      });
      setState(nextState);
      setForm(normalizeForm(nextState.settings));
      setDiagnostics(await clientApi.getDeveloperDiagnostics());
      await onApplied();
    } catch (nextError) {
      setError(developerErrorMessage(nextError, i18n.t('developer.saveFailed'), i18n));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError(null);
    try {
      const nextState = await clientApi.resetDeveloperSettings();
      setState(nextState);
      setForm(normalizeForm(nextState.settings));
      setDiagnostics(await clientApi.getDeveloperDiagnostics());
      setProbeReport(null);
      await onApplied();
    } catch (nextError) {
      setError(developerErrorMessage(nextError, i18n.t('developer.saveFailed'), i18n));
    } finally {
      setSaving(false);
    }
  };

  const probe = async () => {
    setProbing(true);
    setError(null);
    try {
      setProbeReport(await clientApi.probeCloudContracts());
      setDiagnostics(await clientApi.getDeveloperDiagnostics());
    } catch (nextError) {
      setError(developerErrorMessage(nextError, i18n.t('developer.probeFailed'), i18n));
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="developer-panel">
      <header className={`developer-panel-header ${onBack ? 'with-back' : ''}`}>
        {onBack ? (
          <button type="button" onClick={onBack} aria-label={i18n.t('app.settings')}>
            ←
          </button>
        ) : null}
        <div>
          <strong>{i18n.t('developer.title')}</strong>
          <span>{i18n.t('developer.subtitle')}</span>
        </div>
      </header>

      <section className="developer-status">
        <div>
          <span>{i18n.t('developer.currentMode')}</span>
          <strong>{currentModeLabel}</strong>
        </div>
        <small>{effective?.gatewayUrl ?? i18n.t('runtime.noEndpoint')}</small>
      </section>

      <label className="developer-toggle">
        <input
          checked={Boolean(form?.developerMode)}
          type="checkbox"
          onChange={(event) => updateForm({
            developerMode: event.target.checked,
            cloudMode: event.target.checked ? (form?.cloudMode === 'prod' ? 'pre' : form?.cloudMode ?? 'pre') : 'prod',
          })}
        />
        <span>{i18n.t('developer.enable')}</span>
      </label>

      <div className="developer-segmented" role="group" aria-label={i18n.t('developer.cloudMode')}>
        {(['prod', 'pre', 'custom'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={form?.cloudMode === mode ? 'active' : ''}
            onClick={() => updateForm({ cloudMode: mode, developerMode: mode !== 'prod' || Boolean(form?.developerMode) })}
          >
            {modeLabel(i18n, mode)}
          </button>
        ))}
      </div>

      {form?.developerMode ? (
        <section className="developer-fields">
          <label>
            <span>{i18n.t('developer.gatewayUrl')}</span>
            <input
              value={form.gatewayUrl ?? ''}
              placeholder={gatewayPlaceholder}
              onChange={(event) => updateForm({ gatewayUrl: event.target.value })}
            />
          </label>
          <label>
            <span>{i18n.t('developer.streamUrl')}</span>
            <input
              value={form.streamUrl ?? ''}
              placeholder={streamPlaceholder}
              onChange={(event) => updateForm({ streamUrl: event.target.value })}
            />
          </label>
        </section>
      ) : null}

      <section className="developer-diagnostics">
        <div>
          <span>{i18n.t('developer.auth')}</span>
          <strong>{authLabel}</strong>
        </div>
        <div>
          <span>{i18n.t('developer.bucEnv')}</span>
          <strong>{authState?.config.environment ?? '-'}</strong>
        </div>
        <div>
          <span>{i18n.t('developer.lastRequest')}</span>
          <strong>{requestLine(diagnostics) ?? '-'}</strong>
        </div>
        {probeReport ? (
          <div>
            <span>{i18n.t('developer.probe')}</span>
            <strong>
              {probeReport.blockerCount === 0
                ? i18n.t('chat.localProxy.contractsPassed')
                : i18n.t('chat.localProxy.contractsBlocked', { count: probeReport.blockerCount })}
            </strong>
          </div>
        ) : null}
      </section>

      {error ? <p className="developer-error">{error}</p> : null}

      <div className="developer-actions">
        <button type="button" onClick={() => void save()} disabled={saving || !form}>
          {saving ? i18n.t('developer.saving') : i18n.t('developer.apply')}
        </button>
        <button type="button" onClick={() => void probe()} disabled={probing}>
          {probing ? i18n.t('developer.probing') : i18n.t('developer.probe')}
        </button>
        <button type="button" onClick={() => void reset()} disabled={saving}>
          {i18n.t('developer.reset')}
        </button>
      </div>
    </div>
  );
}
