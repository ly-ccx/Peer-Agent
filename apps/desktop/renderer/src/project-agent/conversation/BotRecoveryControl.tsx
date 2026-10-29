import { useId, useState } from 'react';
import type { I18nRuntime, TranslationKey } from '@peer-agent/i18n';
import type { BotRecoveryStatus, ProjectRecoveryView } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
import { useBotRecovery } from '../state/useBotRecovery';
import '../styles/bot-recovery-control.css';

const reasons: Record<string, TranslationKey> = {
  history_conflict: 'recovery.reason.conflict', input_ownership: 'recovery.reason.input', delivery_pending: 'recovery.reason.delivery',
  execution_unknown: 'recovery.reason.unknown', budget_unconfirmed: 'recovery.reason.budget', paused: 'recovery.reason.paused',
  coordination_pending: 'recovery.reason.coordination',
  waiting_user: 'recovery.reason.waiting', child_execution: 'recovery.reason.children', checkpoint_unavailable: 'recovery.reason.checkpoint',
  checkpoint_verified: 'recovery.reason.verified',
};
const stages: Partial<Record<string, TranslationKey>> = { stopping: 'recovery.stopping', backing_up: 'recovery.backing_up', restoring: 'recovery.restoring', reconciling: 'recovery.reconciling' };
type Work = ProjectRecoveryView['works'][number];
type Target = { workId?: string; sessionId?: string };

function groupByReason(works: readonly Work[]) {
  const groups = new Map<TranslationKey, Work[]>();
  for (const work of works) {
    const key = reasons[work.reason] || 'recovery.reason.checkpoint';
    groups.set(key, [...(groups.get(key) || []), work]);
  }
  return [...groups];
}

export function BotRecoveryControl({ workspaceId, status, i18n, onRetry }: {
  readonly workspaceId: string; readonly status: BotRecoveryStatus | null; readonly i18n: I18nRuntime; readonly onRetry: () => void;
}) {
  const recovery = useBotRecovery(workspaceId);
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<Target | null>(null);
  const { view, error, busy } = recovery;
  const held = view?.works.filter(work => work.disposition === 'held') || [];
  const resumable = view?.works.filter(work => work.disposition === 'resume') || [];
  const errorKey = error === 'coordination_resume_plan_changed' ? 'recovery.stale'
    : error === 'coordination_recovery_stop_pending' ? 'recovery.stopPending'
    : error === 'RECOVERY_BUSY' ? 'recovery.busy'
      : ['coordination_recovery_identity_conflict', 'coordination_recovery_unbound_delivery'].includes(error || '') ? 'recovery.unsupported' : 'recovery.failed';
  const title = view?.phase === 'failed' ? 'recovery.failed' : status?.code === 'lease_unavailable' || view?.phase === 'occupied' ? 'recovery.occupied'
    : status?.reason === 'history_conflict' ? 'projectAgent.chat.recoveryConflict'
      : status?.reason === 'reconciliation_required' ? 'projectAgent.chat.recoveryReconcile'
        : status ? 'projectAgent.chat.recoveryBlocked' : view?.canContinue ? view.runtimeReady ? 'recovery.ready' : 'recovery.preserved' : 'recovery.title';
  const counts = view && view.phase !== 'occupied' ? ([
    ['recovery.count.completed', view.completedCount], ['recovery.count.resume', resumable.length], ['recovery.count.held', held.length],
  ] as const).filter(([, count]) => count > 0).map(([key, count]) => i18n.t(key, { count })) : [];
  const retireLabel = i18n.t('recovery.retire');
  const isTarget = (target: Target) => confirm?.workId === target.workId && confirm?.sessionId === target.sessionId;
  const retire = (target: Target) => isTarget(target) ? <div className="bot-recovery-confirm" role="group" aria-label={i18n.t('recovery.confirmRetire')}>
    <p>{i18n.t('recovery.retireHint')}</p>
    <div className="bot-recovery-actions">
      <button type="button" className="bot-recovery-button" disabled={busy} onClick={async () => { await recovery.execute('retain', confirm!); setConfirm(null); }}>{i18n.t('recovery.confirmRetire')}</button>
      <button type="button" className="bot-recovery-link" disabled={busy} onClick={() => setConfirm(null)}>{i18n.t('recovery.cancel')}</button>
    </div>
  </div> : null;
  const retireButton = (target: Target) => <button type="button" className="bot-recovery-link" aria-label={retireLabel} disabled={busy}
    aria-expanded={isTarget(target)} onClick={() => setConfirm(isTarget(target) ? null : target)}>{i18n.t('recovery.retireShort')}</button>;
  const label = (text: string) => text === 'Earlier task' ? i18n.t('recovery.earlierTask') : text;
  const toggle = () => {
    const next = !open; setOpen(next);
    if (next) recovery.check();
  };
  const feedback = busy || recovery.handoff || error;
  return <section className="bot-recovery-control" aria-label={i18n.t('recovery.title')} data-tone={status ? 'blocked' : 'quiet'} data-open={open}>
    <div className="bot-recovery-head">
      <PeerIcon name={status ? 'pause' : 'history'} size={14} className="bot-recovery-mark" />
      <div className="bot-recovery-heading">
        <p role="status" className="bot-recovery-title">{i18n.t(title)}</p>
        {open && counts.length ? <p className="bot-recovery-counts">{counts.join(' · ')}</p> : null}
      </div>
      <button type="button" className="bot-recovery-toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
        <span>{i18n.t(open ? 'recovery.collapse' : 'recovery.inspect')}</span><PeerIcon name="chevronDown" size={12} />
      </button>
    </div>
    {open ? <div id={bodyId} className="bot-recovery-body">
      {view && view.phase !== 'occupied' && (view.works.length || view.sessions.length) ? <div className="bot-recovery-list">
        {view.canContinue && held.length ? <p className="bot-recovery-note">{i18n.t('recovery.held')}</p> : null}
        {groupByReason(view.works).map(([reason, works]) => <div key={reason} className="bot-recovery-group" role="group" aria-label={i18n.t(reason)}>
          <p className="bot-recovery-group-title"><span>{i18n.t(reason).replace(/[。.]$/, '')}</span><span className="bot-recovery-count">{works.length}</span></p>
          <ul>{works.map(work => <li key={work.workId}>
            <div className="bot-recovery-row">
              <strong>{label(work.title)}</strong>
              {view.canContinue && work.disposition === 'held' ? retireButton({ workId: work.workId }) : null}
            </div>
            {retire({ workId: work.workId })}
          </li>)}</ul>
        </div>)}
        {view.sessions.length ? <div className="bot-recovery-group" role="group" aria-label={i18n.t('recovery.children')}>
          <p className="bot-recovery-group-title"><span>{i18n.t('recovery.children').replace(/[。.]$/, '')}</span><span className="bot-recovery-count">{view.sessions.length}</span></p>
          <ul>{view.sessions.map(session => <li key={session.sessionId}>
            <div className="bot-recovery-row">
              <strong>{label(session.title)}</strong>
              {view.canContinue ? retireButton({ sessionId: session.sessionId }) : null}
            </div>
            {retire({ sessionId: session.sessionId })}
          </li>)}</ul>
        </div> : null}
      </div> : null}
      <div className="bot-recovery-footer">
        {feedback ? <div className="bot-recovery-feedback">
          {busy ? <p role="status">{i18n.t(stages[view?.phase || ''] || 'recovery.checking')}</p> : null}
          {recovery.handoff ? <p role="status">{i18n.t('recovery.handoff')}</p> : null}
          {error ? <p role="alert">{i18n.t(errorKey)}</p> : null}
        </div> : null}
        {view?.phase === 'occupied' && view.holder ? <p className="bot-recovery-note">{i18n.t('recovery.holder', {
          surface: view.holder.surface === 'desktop' ? 'Desktop' : 'TUI', version: view.holder.version })}</p> : null}
        {view && view.phase !== 'occupied' ? <p className="bot-recovery-note">{i18n.t('recovery.backup')}</p> : null}
        <div className="bot-recovery-actions">
          {view?.phase === 'occupied' ? <button type="button" className="bot-recovery-button" data-primary="true" disabled={busy || recovery.handoff}
            onClick={() => void recovery.takeover()}>{i18n.t('recovery.takeover')}</button> : null}
          {view && view.phase !== 'occupied' ? <button type="button" className="bot-recovery-button" data-primary={!view.canContinue}
            disabled={busy} onClick={() => void recovery.execute('restore')}>{i18n.t('recovery.restore')}</button> : null}
          <button type="button" className="bot-recovery-link" disabled={busy} onClick={recovery.check}>{i18n.t('recovery.review')}</button>
          {status?.retryable ? <button type="button" className="bot-recovery-link" disabled={busy} onClick={onRetry}>{i18n.t('projectAgent.history.retry')}</button> : null}
        </div>
        {error || status || view?.backupLocation ? <details className="bot-recovery-diagnostics">
          <summary><span>{i18n.t('recovery.diagnostics')}</span><PeerIcon name="chevronDown" size={12} /></summary>
          {error || status ? <p><code>{error || status?.code}</code>{status?.phase ? ` · ${status.phase}` : ''}</p> : null}
          {view?.backupLocation ? <p>{i18n.t('recovery.savedAt')}<br /><code>{view.backupLocation}</code></p> : null}
        </details> : null}
      </div>
    </div> : null}
  </section>;
}
