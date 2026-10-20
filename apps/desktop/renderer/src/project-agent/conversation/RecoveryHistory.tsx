import type { TranslationKey, I18nRuntime } from '@peer-agent/i18n';
import { useEffect, useRef } from 'react';
import { PeerIcon } from '../../ui/icons';
import '../styles/bot-recovery-history.css';

/** Ended attempts remain inspectable without becoming another bot reply. */
export function RecoveryHistory({ createdAt, highlighted, i18n, messageKey, onOpenDetails }: {
  readonly messageKey: TranslationKey; readonly createdAt: string; readonly highlighted: boolean; readonly i18n: I18nRuntime;
  readonly onOpenDetails?: () => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (highlighted && ref.current) ref.current.open = true; }, [highlighted]);
  const date = new Date(createdAt), valid = Number.isFinite(date.valueOf());
  return <details className="bot-recovery-history" ref={ref}>
    <summary><PeerIcon name="history" size={14} /><span>{i18n.t('projectAgent.chat.recoveryHistory')}</span>
      {valid ? <time dateTime={createdAt}>{date.toLocaleString(i18n.locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> : null}
      <PeerIcon name="chevronDown" size={12} /></summary>
    <div className="bot-recovery-history-body">
      <p className="bot-reply-body">{i18n.t(messageKey)}</p>
      {onOpenDetails ? <button type="button" onClick={event => {
        event.currentTarget.focus({ preventScroll: true }); onOpenDetails();
      }}><PeerIcon name="panelRight" size={14} />{i18n.t('projectAgent.chat.context.details')}</button> : null}
    </div>
  </details>;
}
