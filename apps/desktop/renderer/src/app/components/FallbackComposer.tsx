import type { I18nRuntime } from '@zeus-atlas/i18n';
import type { AuthState, ClientSessionState, CloudRuntimeState } from '@zeus-atlas/protocol';
import { AccessLevelLabel } from '@zeus-atlas/ui';
import { cloudStatusKey } from '../runtimeLabels';

export function FallbackComposer({
  session,
  authState,
  cloudRuntime,
  i18n,
}: {
  readonly session: ClientSessionState | null;
  readonly authState: AuthState | null;
  readonly cloudRuntime: CloudRuntimeState | null;
  readonly i18n: I18nRuntime;
}) {
  const canSend = authState?.status === 'authenticated' && cloudRuntime?.status === 'connected';

  return (
    <footer className="composer">
      <div className="context-row">
        <span>{session?.workspaceLabel ?? i18n.t('app.workspaceFallback')}</span>
        <span>{cloudRuntime ? i18n.t(cloudStatusKey(cloudRuntime.status)) : i18n.t('status.connecting')}</span>
        {session ? <AccessLevelLabel value={session.accessLevel} locale={i18n.locale} /> : null}
      </div>
      <div className="composer-box">
        <button type="button" disabled={!canSend}>
          +
        </button>
        <input disabled={!canSend} placeholder={i18n.t(canSend ? 'composer.placeholder' : 'composer.disabledPlaceholder')} />
        <button className="send-button" type="button" disabled={!canSend}>
          ↑
        </button>
      </div>
    </footer>
  );
}
