import type { I18nRuntime } from '@peer-agent/i18n';

export function FormFeedback({ id, i18n, loading, saving, readError, saveError, stale, committed, dirty, onReload, onRetry }: {
  id?: string; i18n: I18nRuntime; loading?: boolean; saving?: boolean; readError?: boolean; saveError?: boolean;
  stale?: boolean; committed?: boolean; dirty?: boolean; onReload?: () => unknown; onRetry?: () => unknown;
}) {
  const error = readError || saveError;
  const key = saveError ? 'forms.saveFailed' : readError ? 'forms.loadFailed' : saving ? 'forms.saving'
    : loading ? 'forms.loading' : stale ? 'forms.stale' : dirty ? 'forms.unsaved' : committed ? 'forms.saved' : null;
  if (!key) return id ? <div id={id} role="status" /> : null;
  return <div id={id} className={`ui-form-feedback${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}>
    <span>{i18n.t(key)}</span>
    {(error || dirty && !loading && !saving) && (error ? saveError ? onRetry : onReload : onRetry) ? <button type="button" className="ui-button is-compact" disabled={loading || saving} onClick={() => { void (error ? saveError ? onRetry : onReload : onRetry)?.(); }}>{i18n.t(error ? 'forms.retry' : 'forms.save')}</button> : null}
  </div>;
}
