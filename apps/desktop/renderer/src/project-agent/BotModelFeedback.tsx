import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotModelsControlState } from './state/useBotModels';
import { FormFeedback } from '../ui/forms/FormFeedback';

export function BotModelFeedback({ state, i18n, showLoading = true, showSaving = true }: { state: BotModelsControlState; i18n: I18nRuntime; showLoading?: boolean; showSaving?: boolean }) {
  const loading = showLoading && !state.loaded && state.reading;
  const saving = showSaving && state.busy;
  const noModels = state.loaded && !state.readError && state.models.length === 0;
  const pending = state.pending && !state.busy;
  if (!loading && !saving && !state.readError && !state.saveError && !noModels && !pending) return null;
  return <div className="bot-model-feedback">
    <FormFeedback i18n={i18n} loading={loading} saving={saving} readError={Boolean(state.readError)} saveError={Boolean(state.saveError) && !pending} onReload={state.reload} onRetry={state.retry} />
    {noModels ? <p className="ui-form-feedback">{i18n.t('forms.noModels')}</p> : null}
    {pending ? <div className={`ui-form-feedback${state.saveError ? ' is-error' : ''}`} role={state.saveError ? 'alert' : 'status'}>
      <span>{i18n.t(state.saveError ? 'forms.saveFailed' : 'forms.pendingSelection')}</span>
      <button type="button" className="ui-button is-compact" disabled={state.reading} onClick={() => { void state.retry(); }}>{i18n.t('forms.retry')}</button>
      <button type="button" className="ui-button is-compact" disabled={state.reading} onClick={state.discard}>{i18n.t('forms.discard')}</button>
    </div> : null}
  </div>;
}
