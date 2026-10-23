import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotModelsControlState } from './state/useBotModels';
import { FormFeedback } from '../ui/forms/FormFeedback';

export function BotModelFeedback({ state, i18n }: { state: BotModelsControlState; i18n: I18nRuntime }) {
  return <div className="bot-model-feedback">
    <FormFeedback i18n={i18n} loading={state.reading} saving={state.busy} readError={Boolean(state.readError)} saveError={Boolean(state.saveError)} onReload={state.reload} onRetry={state.retry} />
    {state.loaded && !state.reading && !state.readError && state.models.length === 0 ? <p className="ui-form-feedback">{i18n.t('forms.noModels')}</p> : null}
    {state.pending && !state.busy ? <div className="ui-form-feedback"><span>{i18n.t('forms.pendingSelection')}</span><button type="button" className="ui-button is-compact" onClick={() => { void state.retry(); }}>{i18n.t('forms.retry')}</button><button type="button" className="ui-button is-compact" onClick={state.discard}>{i18n.t('forms.discard')}</button></div> : null}
  </div>;
}
