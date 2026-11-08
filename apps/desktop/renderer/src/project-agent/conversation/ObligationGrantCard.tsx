import { useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import '../styles/obligation-grant-card.css';

export interface ObligationGrantItem {
  readonly sessionId: string;
  readonly title?: string;
  readonly shortId?: string;
  readonly gaps?: readonly string[];
}

export interface ObligationGrantView {
  readonly grantId: string;
  readonly status: string;
  readonly items: readonly ObligationGrantItem[];
}

export interface ObligationWriterState {
  readonly ok: boolean;
  readonly code?: string | null;
  readonly check?: string | null;
  readonly seal?: string | null;
  readonly change?: string | null;
  readonly file?: string | null;
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

function itemLabel(item: ObligationGrantItem, i18n: I18nRuntime) {
  if (item.title) return item.title;
  return i18n.t('projectAgent.workPanel.obligationShort', { id: item.shortId || item.sessionId.slice(0, 8) });
}

export function ObligationGrantCard({ grant, submitting, blocked, i18n, onConfirm, onReject }: {
  readonly grant: ObligationGrantView;
  readonly submitting: boolean;
  readonly blocked: ObligationWriterState | null;
  readonly i18n: I18nRuntime;
  readonly onConfirm: (grantId: string) => void;
  readonly onReject: (grantId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const gaps = grant.items.flatMap(item => (item.gaps || []).map(gap => ({ sessionId: item.sessionId, gap })));
  const disabled = submitting || blocked != null;
  return <article id={`obligation-grant-${grant.grantId}`} tabIndex={-1} className="obligation-grant-card" data-grant-id={grant.grantId} data-blocked={blocked ? 'true' : 'false'} aria-busy={submitting} aria-label={i18n.t('projectAgent.workPanel.obligationTitle', { count: grant.items.length })}>
    <header>
      <h3>{i18n.t('projectAgent.workPanel.obligationTitle', { count: grant.items.length })}</h3>
      <button type="button" className="ui-button is-compact" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{i18n.t(collapsed ? 'projectAgent.workPanel.obligationExpand' : 'projectAgent.workPanel.obligationCollapse')}</button>
    </header>
    {collapsed ? null : <ul>{grant.items.map(item => <li key={item.sessionId}>{itemLabel(item, i18n)}</li>)}</ul>}
    <p className="obligation-grant-consequence">{i18n.t('projectAgent.workPanel.obligationConsequence')}</p>
    {gaps.length ? <details className="obligation-grant-details">
      <summary>{i18n.t('projectAgent.workPanel.obligationDetails')}</summary>
      <ul>{gaps.map(item => <li key={`${item.sessionId}:${item.gap}`}>{gapLabel(item.gap, i18n)}</li>)}</ul>
    </details> : null}
    {blocked ? <p className="obligation-grant-blocked" role="status">{i18n.t('projectAgent.workPanel.obligationBlocked')}<span className="obligation-grant-code">{blocked.code}</span></p> : null}
    <div className="obligation-grant-actions">
      <button type="button" className="ui-button is-primary is-compact" disabled={disabled} onClick={() => onConfirm(grant.grantId)}>{i18n.t('projectAgent.workPanel.obligationConfirm')}</button>
      <button type="button" className="ui-button is-compact" disabled={disabled} onClick={() => onReject(grant.grantId)}>{i18n.t('projectAgent.workPanel.obligationReject')}</button>
    </div>
  </article>;
}

export function ObligationGrantList({ grants, error, writer = null, submittingId, i18n, onConfirm, onReject, onRetry, variant = 'chat' }: {
  readonly grants: readonly ObligationGrantView[];
  readonly error: string | null;
  readonly writer?: ObligationWriterState | null;
  readonly submittingId: string | null;
  readonly i18n: I18nRuntime;
  readonly onConfirm: (grantId: string) => void;
  readonly onReject: (grantId: string) => void;
  readonly onRetry: () => void;
  readonly variant?: 'chat' | 'panel';
}) {
  if (!grants.length && !error) return null;
  const blocked = writer && writer.ok === false ? writer : null;
  if (variant === 'panel') {
    return <div className="obligation-grant-entries" data-obligation-count={grants.length}>
      {grants.map(grant => <button key={grant.grantId} type="button" className="obligation-grant-entry" onClick={() => {
        const card = document.getElementById(`obligation-grant-${grant.grantId}`);
        card?.scrollIntoView({ block: 'nearest' });
        if (card instanceof HTMLElement) card.focus();
      }}>{i18n.t('projectAgent.workPanel.obligationEntry', { count: grant.items.length })}</button>)}
      {blocked ? <p className="obligation-grant-blocked" role="status">{blocked.code}</p> : null}
    </div>;
  }
  return <div className="obligation-grant-dock" data-obligation-count={grants.length}>
    {error ? <div className="obligation-grant-error" role="alert">
      <p>{i18n.t('projectAgent.workPanel.obligationError')}</p>
      <p className="obligation-grant-code">{error}</p>
      <button type="button" className="ui-button is-compact" onClick={onRetry}>{i18n.t('projectAgent.workPanel.obligationRetry')}</button>
    </div> : null}
    {grants.map(grant => <ObligationGrantCard key={grant.grantId} grant={grant} submitting={submittingId === grant.grantId} blocked={blocked}
      i18n={i18n} onConfirm={onConfirm} onReject={onReject} />)}
  </div>;
}
