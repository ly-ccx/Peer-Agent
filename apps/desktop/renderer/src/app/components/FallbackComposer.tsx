import type { I18nRuntime } from '@peer-agent/i18n';
import type { ClientSessionState } from '@peer-agent/protocol';
import { AccessLevelLabel } from '@peer-agent/ui';
import { PeerIcon } from '../../ui/icons';

export function FallbackComposer({
  session,
  i18n,
}: {
  readonly session: ClientSessionState | null;
  readonly i18n: I18nRuntime;
}) {
  return (
    <footer className="composer">
      <div className="context-row">
        <span>{session?.workspaceLabel ?? i18n.t('app.workspaceFallback')}</span>
        {session ? <AccessLevelLabel value={session.accessLevel} locale={i18n.locale} /> : null}
      </div>
      <div className="composer-box">
        <button type="button" disabled><PeerIcon name="plus" size={16} /></button>
        <input disabled placeholder={i18n.t('composer.disabledPlaceholder')} />
        <button className="send-button" type="button" disabled><PeerIcon name="send" size={16} /></button>
      </div>
    </footer>
  );
}
