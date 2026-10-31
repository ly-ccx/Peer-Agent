import { useEffect, useId, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { normalizeInputPredictionSettings, type InputPredictionSettings, type InputPredictionStatus } from '@peer-agent/protocol';
import { clientApi } from '../../../clientApi';
import { publishInputPredictionPreferences } from '../../../chat/state/inputPredictionPreferences';
import { Switch } from '../../../ui/boolean-controls/Switch';
import { SettingsGroup } from '../../../ui/settings/SettingsGroup';
import { FormFeedback } from '../../../ui/forms/FormFeedback';
import { useEditableResource } from '../../../ui/forms/useEditableResource';
import { useUnsavedChanges } from '../../../ui/forms/UnsavedChanges';
import { Dropdown } from '../Dropdown';

export function InputPredictionPanel({ i18n }: { readonly i18n: I18nRuntime }) {
  const descriptionId = useId(), disclosureId = useId();
  const [status, setStatus] = useState<InputPredictionStatus | null>(null);
  const [models, setModels] = useState<{ value: string; label: string }[]>([]);
  const [modelId, setModelId] = useState(''), [modelBusy, setModelBusy] = useState(false);
  const [modelReadVersion, setModelReadVersion] = useState(0);
  const [modelError, setModelError] = useState(false), [modelRetry, setModelRetry] = useState('');
  const [selectedWorkspace, setSelectedWorkspace] = useState('');
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const form = useEditableResource('settings.input-prediction', normalizeInputPredictionSettings(null), {
    read: async () => {
      const settings = await clientApi.getSettings();
      const value = normalizeInputPredictionSettings(settings.inputPrediction);
      publishInputPredictionPreferences(value); return value;
    },
    write: async draft => {
      const result = await clientApi.updateSettings({ inputPrediction: draft });
      const value = normalizeInputPredictionSettings(result.inputPrediction);
      publishInputPredictionPreferences(value); return value;
    },
  });
  useUnsavedChanges({ dirty: form.dirty, busy: form.saving, save: form.save, discard: form.reset });
  useEffect(() => {
    let live = true;
    void Promise.all([clientApi.getSettings(), clientApi.modelRoutingGet()]).then(([settings, routing]) => {
      if (!live) return;
      setModelError(false);
      setModels(routing.providers.map(model => ({ value: model.id, label: model.label })));
      const raw = settings.modelRouting as { roles?: { input_predictor?: { mode: string; modelProviderId?: string } } } | undefined;
      const selected = raw?.roles?.input_predictor;
      setModelId(selected?.mode === 'fixed' ? selected.modelProviderId ?? '' : selected ? 'configured' : '');
      const projects = Array.isArray(settings.workspaces) ? settings.workspaces.filter(row => row.id && row.name) : [];
      setWorkspaces(projects); setSelectedWorkspace(projects.find(row => row.path === settings.activeWorkspace)?.id ?? projects[0]?.id ?? '');
    }).catch(() => { if (live) setModelError(true); });
    return () => { live = false; };
  }, [modelReadVersion]);
  useEffect(() => {
    let live = true;
    void clientApi.inputPredictionStatus().then(value => { if (live) setStatus(value); }).catch(() => { if (live) setStatus(null); });
    return () => { live = false; };
  }, [form.saved, modelId]);
  async function selectModel(id: string) {
    if (!id || id === 'configured' || modelBusy) return;
    setModelBusy(true); setModelError(false); setModelRetry(id);
    try {
      await clientApi.modelRoutingUpdate({ roles: { input_predictor: { mode: 'fixed', modelProviderId: id } } });
      setModelId(id); setModelRetry('');
    } catch { setModelError(true); }
    finally { setModelBusy(false); }
  }
  async function change(patch: Partial<InputPredictionSettings>) {
    if (!form.loaded || form.saving) return;
    form.edit({ ...form.draft, ...patch }); await form.save();
  }
  const disabled = !form.loaded || form.saving;
  return <SettingsGroup title={i18n.t('inputPrediction.title')} description={i18n.t('inputPrediction.description')} className="general-section">
    <div className="general-setting-row">
      <div className="general-setting-copy"><h3>{i18n.t('inputPrediction.enabled')}</h3><p id={descriptionId}>{i18n.t('inputPrediction.nextDisclosure')}</p></div>
      <Switch checked={form.draft.enabled} disabled={disabled} aria-label={i18n.t('inputPrediction.enabled')}
        aria-describedby={descriptionId} onCheckedChange={enabled => { void change({ enabled }); }} />
    </div>
    <div className="general-setting-row">
      <div className="general-setting-copy"><h3>{i18n.t('inputPrediction.model')}</h3><p>{i18n.t('inputPrediction.modelHelp')}</p></div>
      <div className="general-language-select"><Dropdown value={modelId} disabled={modelBusy || !models.length}
        ariaLabel={i18n.t('inputPrediction.model')} placeholder={i18n.t('inputPrediction.chooseModel')}
        options={[...(modelId === 'configured' ? [{ value: 'configured', label: i18n.t('inputPrediction.routing') }] : []), ...models]}
        onChange={id => { void selectModel(id); }} /></div>
    </div>
    {!modelId && form.draft.enabled ? <p className="ui-form-feedback" role="status">{i18n.t('inputPrediction.chooseModel')}</p> : null}
    {modelError ? <FormFeedback i18n={i18n} saveError={!!modelRetry} readError={!modelRetry}
      onRetry={() => selectModel(modelRetry)} onReload={() => setModelReadVersion(value => value + 1)} /> : null}
    <div className="general-setting-row">
      <div className="general-setting-copy"><h3>{i18n.t('inputPrediction.continuation')}</h3><p id={disclosureId}>{i18n.t('inputPrediction.draftDisclosure')}</p></div>
      <Switch checked={form.draft.continuationEnabled} disabled={disabled} aria-label={i18n.t('inputPrediction.continuation')}
        aria-describedby={disclosureId} onCheckedChange={continuationEnabled => { void change({ continuationEnabled }); }} />
    </div>
    {(['dailyRequestLimit', 'dailyTokenLimit'] as const).map(key => <div className="general-setting-row" key={key}>
      <label className="general-setting-copy" htmlFor={`${descriptionId}-${key}`}><h3>{i18n.t(key === 'dailyRequestLimit' ? 'inputPrediction.requestLimit' : 'inputPrediction.tokenLimit')}</h3><p>{i18n.t('inputPrediction.limitHelp')}</p></label>
      <div className="general-language-select"><input id={`${descriptionId}-${key}`} type="number" min={0} step={1}
        disabled={disabled} value={form.draft[key]} aria-invalid={!Number.isSafeInteger(form.draft[key]) || form.draft[key] < 0}
        onChange={event => form.edit({ ...form.draft, [key]: Number(event.target.value) })}
        onBlur={() => { if (Number.isSafeInteger(form.draft[key]) && form.draft[key] >= 0) void form.save(); }} /></div>
    </div>)}
    {workspaces.length > 0 ? <div className="general-setting-row">
      <div className="general-setting-copy"><h3>{i18n.t('inputPrediction.project')}</h3></div>
      <div className="general-bots-hours">
        <Dropdown value={selectedWorkspace} options={workspaces.map(workspace => ({ value: workspace.id, label: workspace.name }))}
          ariaLabel={i18n.t('inputPrediction.project')} onChange={setSelectedWorkspace} />
        <Switch checked={!form.draft.disabledWorkspaceIds.includes(selectedWorkspace)} disabled={disabled || !selectedWorkspace}
          aria-label={`${workspaces.find(row => row.id === selectedWorkspace)?.name ?? ''}: ${i18n.t('inputPrediction.enabled')}`}
          onCheckedChange={enabled => { void change({ disabledWorkspaceIds: enabled
            ? form.draft.disabledWorkspaceIds.filter(id => id !== selectedWorkspace)
            : [...form.draft.disabledWorkspaceIds, selectedWorkspace] }); }} />
      </div>
    </div> : null}
    {status ? <p className="ui-form-feedback" role="status">
      {i18n.t(({ ready: 'inputPrediction.statusReady', disabled: 'inputPrediction.statusDisabled',
        model_unconfigured: 'inputPrediction.chooseModel', budget: 'inputPrediction.statusBudget',
        usage_unavailable: 'inputPrediction.statusUsage', provider_error: 'inputPrediction.statusProvider' } as const)[status.reason])}
      {' '}{i18n.t('inputPrediction.usage')}: {status.requests} / {status.tokens}{status.estimated ? ` (${i18n.t('inputPrediction.estimated')})` : ''}
    </p> : null}
    <FormFeedback i18n={i18n} {...form} onReload={form.reload} onRetry={form.save} />
  </SettingsGroup>;
}
