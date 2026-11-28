import type { I18nRuntime } from '@peer-agent/i18n';
import type { EditableSnapshot } from '../../../ui/forms/editableResource';

type RoutingFeedbackState = Pick<EditableSnapshot<unknown>, 'loading' | 'saving' | 'readError' | 'saveError' | 'stale' | 'dirty' | 'committed'>;

export function ModelRoutingFeedback({ i18n, form, saveDetail, selectionError, previewError, onReload, onRetry, onDiscard, onRetryPreview }: {
  i18n: I18nRuntime;
  form: RoutingFeedbackState;
  saveDetail?: string;
  selectionError?: string;
  previewError?: boolean;
  onReload: () => unknown;
  onRetry: () => unknown;
  onDiscard: () => void;
  onRetryPreview?: () => void;
}) {
  const { saving, loading, saveError, readError, stale, dirty, committed } = form;
  const busy = saving || loading;
  const key = saving ? 'forms.saving' : loading ? 'forms.loading' : saveError ? 'forms.saveFailed'
    : readError ? 'forms.loadFailed' : selectionError ? null : stale ? 'forms.stale' : dirty ? 'forms.pendingSelection'
      : previewError ? 'forms.previewFailed' : committed ? 'forms.saved' : null;
  const detail = busy ? undefined : saveError ? saveDetail || selectionError : readError ? undefined : selectionError;
  const message = [key ? i18n.t(key) : '', detail].filter(Boolean).join(' ');
  if (!message) return null;
  const error = !busy && (saveError || readError || Boolean(selectionError));
  const retry = busy ? undefined : saveError ? onRetry : readError ? onReload : dirty ? onRetry : previewError && !selectionError ? onRetryPreview : undefined;
  return (
    <div className={`ui-form-feedback${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}>
      <span>{message}</span>
      {retry ? <button type="button" className="ui-button is-compact" onClick={() => { void retry(); }}>{i18n.t('forms.retry')}</button> : null}
      {dirty ? <button type="button" className="ui-button is-compact" disabled={busy} onClick={onDiscard}>{i18n.t('forms.discard')}</button> : null}
    </div>
  );
}
