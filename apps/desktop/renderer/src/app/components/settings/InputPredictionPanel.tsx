import { useEffect, useId, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { normalizeInputPredictionSettings, type ModelRoutingMenuOption, type InputPredictionSettings, type InputPredictionStatus } from '@peer-agent/protocol';
import { clientApi } from '../../../clientApi';
import { publishInputPredictionPreferences } from '../../../chat/state/inputPredictionPreferences';
import { Switch } from '../../../ui/boolean-controls/Switch';
import { SettingsGroup } from '../../../ui/settings/SettingsGroup';
import { FormFeedback } from '../../../ui/forms/FormFeedback';
import { useEditableResource } from '../../../ui/forms/useEditableResource';
import { useUnsavedChanges } from '../../../ui/forms/UnsavedChanges';
import { ModelPicker } from '../../../ui/model-picker/ModelPicker';
import { selectionGroupsFromRoutingModels } from '../../../ui/model-picker/modelSelection';

export function InputPredictionPanel({ i18n }: { readonly i18n: I18nRuntime }) {
  const descriptionId = useId(), modelHelpId = useId();
  const [status, setStatus] = useState<InputPredictionStatus | null>(null);
  const [models, setModels] = useState<readonly ModelRoutingMenuOption[]>([]);
  const [modelId, setModelId] = useState(''), [modelBusy, setModelBusy] = useState(false);
  const [modelReadVersion, setModelReadVersion] = useState(0);
  const [modelError, setModelError] = useState(false), [modelRetry, setModelRetry] = useState('');
  const [modelsLoaded, setModelsLoaded] = useState(false);
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
      setModels(routing.providers);
      const raw = settings.modelRouting as { roles?: { input_predictor?: { mode: string; modelProviderId?: string } } } | undefined;
      const selected = raw?.roles?.input_predictor;
      setModelId(selected?.mode === 'fixed' ? selected.modelProviderId ?? '' : selected ? 'configured' : '');
      setModelsLoaded(true);
    }).catch(() => { if (live) setModelError(true); });
    return () => { live = false; };
  }, [modelReadVersion]);
  useEffect(() => {
    let live = true;
    void clientApi.inputPredictionStatus().then(value => { if (live) setStatus(value); }).catch(() => { if (live) setStatus(null); });
    return () => { live = false; };
  }, [form.saved, modelId]);
  async function selectModel(id: string) {
    if (!id || id === 'configured' || modelBusy || !form.loaded || form.saving) return;
    setModelBusy(true); setModelError(false); setModelRetry(id);
    try {
      await clientApi.modelRoutingUpdate({ roles: { input_predictor: { mode: 'fixed', modelProviderId: id } } });
      setModelId(id); setModelRetry('');
      // The model row discloses conversation and draft use before this explicit choice.
      form.edit({ ...form.draft, continuationEnabled: true });
      await form.save();
    } catch { setModelError(true); }
    finally { setModelBusy(false); }
  }
  async function change(patch: Partial<InputPredictionSettings>) {
    if (!form.loaded || form.saving) return;
    form.edit({ ...form.draft, ...patch }); await form.save();
  }
  const disabled = !form.loaded || form.saving || modelBusy;
  const unavailable = form.draft.enabled && modelId && status
    ? ({ ready: null, disabled: null, model_unconfigured: null, budget: 'inputPrediction.statusBudget',
      usage_unavailable: 'inputPrediction.statusUsage', provider_error: 'inputPrediction.statusProvider' } as const)[status.reason] : null;
  return <SettingsGroup title={i18n.t('inputPrediction.title')} description={i18n.t('inputPrediction.description')}
    className="general-section input-prediction-settings">
    <div className="general-setting-row">
      <div className="general-setting-copy">
        <h3>{i18n.t('inputPrediction.enabled')}</h3>
        <p id={descriptionId}>{i18n.t('inputPrediction.nextDisclosure')}</p>
        <FormFeedback i18n={i18n} loading={!form.loaded && form.loading} readError={form.readError}
          saveError={form.saveError} stale={form.stale} dirty={form.dirty && !form.saving}
          onReload={form.reload} onRetry={form.save} />
      </div>
      <Switch checked={form.draft.enabled} disabled={disabled} aria-label={i18n.t('inputPrediction.enabled')}
        aria-busy={form.saving} aria-describedby={descriptionId}
        onCheckedChange={enabled => { void change({ enabled, continuationEnabled: enabled }); }} />
    </div>
    <div className="general-setting-row">
      <div className="general-setting-copy">
        <h3>{i18n.t('inputPrediction.model')}</h3>
        <p id={modelHelpId}>{i18n.t(modelsLoaded && !models.length ? 'inputPrediction.noModels' : 'inputPrediction.modelHelp')}</p>
        {modelError ? <FormFeedback i18n={i18n} saveError={!!modelRetry} readError={!modelRetry}
          onRetry={() => selectModel(modelRetry)} onReload={() => setModelReadVersion(value => value + 1)} /> : null}
        {unavailable ? <p role="status">{i18n.t(unavailable)}</p> : null}
      </div>
      <div className="general-language-select" aria-busy={modelBusy}>
        <ModelPicker selectedModelId={modelId} variant="field"
          groups={selectionGroupsFromRoutingModels(models, i18n.locale.startsWith('zh'))}
          disabled={!form.loaded} selectionDisabled={disabled || !models.length} busy={modelBusy}
          ariaLabel={i18n.t('inputPrediction.model')} ariaDescribedBy={modelHelpId}
          label={models.find(model => model.id === modelId)?.label
            ?? i18n.t(modelId === 'configured' ? 'inputPrediction.routing' : 'inputPrediction.chooseModel')}
          isZh={i18n.locale.startsWith('zh')} onSelectModel={selectModel} />
      </div>
    </div>
  </SettingsGroup>;
}
