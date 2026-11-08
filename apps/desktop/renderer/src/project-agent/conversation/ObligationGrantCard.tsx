import type { I18nRuntime } from '@peer-agent/i18n';
import '../styles/obligation-grant-card.css';

export interface ObligationGrantItem {
  readonly sessionId: string;
  readonly title?: string;
  readonly gaps?: readonly string[];
}

export interface ObligationGrantView {
  readonly grantId: string;
  readonly status: string;
  readonly items: readonly ObligationGrantItem[];
}

const GAP_LABELS: Record<string, 'projectAgent.workPanel.gapHostEpoch' | 'projectAgent.workPanel.gapOwnership' | 'projectAgent.workPanel.gapRegistration' | 'projectAgent.workPanel.gapRecorder' | 'projectAgent.workPanel.gapUnknownCalls' | 'projectAgent.workPanel.gapHandles'> = {
  host_epoch_mismatch: 'projectAgent.workPanel.gapHostEpoch',
  ownership_unknown: 'projectAgent.workPanel.gapOwnership',
  dispatch_registration_absent: 'projectAgent.workPanel.gapRegistration',
  no_recorder_tuple: 'projectAgent.workPanel.gapRecorder',
  unknown_calls: 'projectAgent.workPanel.gapUnknownCalls',
  open_handles: 'projectAgent.workPanel.gapHandles',
};

function gapLabel(gap: string, i18n: I18nRuntime) {
  const key = GAP_LABELS[gap];
  return key ? i18n.t(key) : gap;
}

export function ObligationGrantCard({ grant, submitting, i18n, onConfirm, onReject }: {
  readonly grant: ObligationGrantView;
  readonly submitting: boolean;
  readonly i18n: I18nRuntime;
  readonly onConfirm: (grantId: string) => void;
  readonly onReject: (grantId: string) => void;
}) {
  return <article className="obligation-grant-card" data-grant-id={grant.grantId} aria-label={i18n.t('projectAgent.workPanel.obligationPending')}>
    <h3>{i18n.t('projectAgent.workPanel.obligationPending')}</h3>
    <ul>{grant.items.map(item => <li key={item.sessionId}>
      <strong>{item.title || item.sessionId}</strong>
      {item.gaps?.length ? <span className="obligation-grant-gaps">{i18n.t('projectAgent.workPanel.obligationUnknown')}：{item.gaps.map(gap => gapLabel(gap, i18n)).join('、')}</span> : null}
    </li>)}</ul>
    <p>{i18n.t('projectAgent.workPanel.obligationConsequence')}</p>
    <div className="obligation-grant-actions">
      <button type="button" className="ui-button is-compact" disabled={submitting} onClick={() => onConfirm(grant.grantId)}>{i18n.t('projectAgent.workPanel.obligationConfirm')}</button>
      <button type="button" className="ui-button is-compact" disabled={submitting} onClick={() => onReject(grant.grantId)}>{i18n.t('projectAgent.workPanel.obligationReject')}</button>
    </div>
  </article>;
}

export function ObligationGrantList({ grants, error, submittingId, i18n, onConfirm, onReject, onRetry }: {
  readonly grants: readonly ObligationGrantView[];
  readonly error: string | null;
  readonly submittingId: string | null;
  readonly i18n: I18nRuntime;
  readonly onConfirm: (grantId: string) => void;
  readonly onReject: (grantId: string) => void;
  readonly onRetry: () => void;
}) {
  if (!grants.length && !error) return null;
  return <div className="obligation-grant-list" data-obligation-count={grants.length}>
    {error ? <div className="obligation-grant-error" role="alert">
      <p>{i18n.t('projectAgent.workPanel.obligationError')}</p>
      <p className="obligation-grant-code">{error}</p>
      <button type="button" className="ui-button is-compact" onClick={onRetry}>{i18n.t('projectAgent.workPanel.obligationRetry')}</button>
    </div> : null}
    {grants.map(grant => <ObligationGrantCard key={grant.grantId} grant={grant} submitting={submittingId === grant.grantId}
      i18n={i18n} onConfirm={onConfirm} onReject={onReject} />)}
  </div>;
}
