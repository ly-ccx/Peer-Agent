import type { I18nRuntime } from '@peer-agent/i18n';
import type { ResourceAction } from './resourceState';

export function ResourceFeedback({ i18n, loading, error, action, onReload }: {
  readonly i18n: I18nRuntime; readonly loading?: boolean; readonly error?: boolean;
  readonly action?: ResourceAction; readonly onReload?: () => unknown;
}) {
  const failed = error || action?.error;
  const message = loading ? 'resources.loading' : action?.pending ? 'resources.pending'
    : error ? 'resources.readFailed' : action?.error ? 'resources.unconfirmed'
      : action?.cancelled ? 'resources.cancelled' : action?.confirmed ? 'resources.confirmed' : null;
  return message ? <div className="ui-form-feedback" role={failed ? 'alert' : 'status'} aria-busy={loading || action?.pending}>
    <p>{i18n.t(message)}</p>
    {failed && onReload ? <button type="button" className="ui-button" disabled={loading || action?.pending} onClick={() => void onReload()}>{i18n.t('resources.retryRead')}</button> : null}
  </div> : null;
}
